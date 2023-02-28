import { Inject, Injectable } from '@nestjs/common';
import { EventsGateway } from '../events.gateway';
import { DapiRepository } from '../model/dapi/dapi.respository';
import { ConfigService } from '@nestjs/config';
import * as phala from '../phat.composer';
import { DapiEntity } from '../model/dapi/dapi.entity';
import { JobStatus } from 'src/model/dapi/types';
import { ChainType } from 'src/model/chain/types';
import { DataSource } from 'typeorm';
import { ChainRepository } from 'src/model/chain/chain.respository';
import { nanoid } from 'nanoid';
import { Web2InfoEntity } from 'src/model/web2Info/web2Info.entity';
import { OracleEntity } from 'src/model/oracle/oracle.entity';
import { apiCallParametersSchema } from '@api3/airnode-node/dist/src/validation';

@Injectable()
export class DapiService {
  public constructor(
    private readonly ws: EventsGateway,
    private readonly dapiRepository: DapiRepository,
    private readonly chainRepo: ChainRepository,
    private readonly configService: ConfigService,
    @Inject('PG_SOURCE')
    private dataSource: DataSource,
  ) {}

  async emit(jobId: string, s: JobStatus) {
    this.ws.server.emit('status', {
      jobId: jobId,
      status: JobStatus[s],
      progress: s * 10,
    });
    await this.dapiRepository.updateStatus(jobId, s);
  }

  status(n: number): string {
    return JobStatus[n];
  }

  async checkOpenapi(spec: any): Promise<any> {
    return { ok: true };
  }

  async deployQjs(): Promise<any> {
    const sponsorMnemonic = this.configService.get('SPONSOR_MNEMONIC');
    await phala.deployFatContract(
      sponsorMnemonic,
      '0x0000000000000000000000000000000000000000000000000000000000000000',
      'ws://localhost:19944',
      'http://localhost:18000',
      this.configService.get('QJS_PATH'),
      true,
    );
  }

  async submitV2(dapi: DapiEntity): Promise<any> {
    console.log('deploying oralce service ...');
    // prepare data
    const sponsorMnemonic = this.configService.get('SPONSOR_MNEMONIC');
    const jsEngineCodeHash = this.configService.get('JS_ENGINE_CODE_HASH');
    const saas3ProtocolAddress = this.configService.get(
      'SAAS3_PROTOCOL_ADDRESS',
    );

    // find chain info
    dapi.oracleInfo.sourceChain = await this.chainRepo.findByChainId(
      dapi.oracleInfo.sourceChain.chainId,
    );
    dapi.oracleInfo.targetChain = await this.chainRepo.findByChainId(
      dapi.oracleInfo.targetChain.chainId,
    );

    // phala source chain
    if (dapi.oracleInfo.sourceChain.type == ChainType.PHALA) {
      await this.dapiRepository.updateStatus(
        dapi.id,
        JobStatus.DEPOLYING_SAAS3_DRUNTIME,
      );

      console.log('deploying druntime fat contract ...');
      // deploy our druntime first, so it will fail fast
      dapi.oracleInfo.address = await phala.deployFatContract(
        sponsorMnemonic,
        dapi.oracleInfo.sourceChain.clusterId,
        dapi.oracleInfo.sourceChain.wsProvider,
        dapi.oracleInfo.sourceChain.pruntime,
        this.configService.get('DRUNTIME_FAT_PATH'),
      );
      // druntime need anchor contract address, we'll do it later

      this.dapiRepository.updateStatus(
        dapi.id,
        JobStatus.DEPLOYING_PHALA_TRANSACTOR,
      );

      // deploy phala anchor
      if (dapi.oracleInfo.targetChain.type == ChainType.EVM) {
        console.log('deploying phala anchor ...');

        await this.dapiRepository.updateStatus(
          dapi.id,
          JobStatus.DEPLOYING_PHALA_ANCHOR,
        );
        const artifact = phala.loadAnchorArtifact(
          this.configService.get('PHALA_ANCHOR_PATH'),
        );
        console.log('artifact loaded.');
        let res = await phala.deployWithWeb3(
          dapi.oracleInfo.targetChain.httpProvider,
          sponsorMnemonic,
          artifact.abi,
          artifact.bytecode,
          [
            dapi.oracleInfo.wallet,
            saas3ProtocolAddress,
            '0x000000000000000000000000000000000000000000000000000000000000002000000000000000000000000000000000000000000000000000000000000000017100000000000000000000000000000000000000000000000000000000000000',
          ],
        );
        dapi.oracleInfo.anchor = res.address;
      }

      // config druntime
      await phala.configFatContract(
        sponsorMnemonic,
        dapi.oracleInfo.sourceChain.wsProvider,
        dapi.oracleInfo.sourceChain.pruntime,
        this.configService.get('DRUNTIME_FAT_PATH'),
        'config',
        {
          target_chain_rpc: dapi.oracleInfo.targetChain.httpProvider,
          anchor_contract_addr: dapi.oracleInfo.anchor,
          submit_key: null,
          web2_api_url_prefix: dapi.oracleInfo.web2Info.uri,
          js_engine_code_hash: jsEngineCodeHash,
          method: dapi.oracleInfo.web2Info.method.toUpperCase(),
          auth_type: dapi.oracleInfo.web2Info.authType,
          api_key: 'TODO',
        },
      );
    }

    dapi.status = JobStatus.DONE;
    await this.dapiRepository.update(dapi);
  }

  save(entity: DapiEntity) {
    return this.dataSource.transaction(async (manager) => {
      const sourceChain = await this.chainRepo.findByChainId(
        entity.oracleInfo.sourceChain.chainId,
      );
      const targetChain = await this.chainRepo.findByChainId(
        entity.oracleInfo.targetChain.chainId,
      );
      if (!sourceChain || !targetChain) {
        throw new Error('This chain is not supported.');
      }
      entity.oracleInfo.web2Info.id = nanoid();
      entity.oracleInfo.id = nanoid();
      await manager.insert(Web2InfoEntity, entity.oracleInfo.web2Info);
      await manager.insert(OracleEntity, entity.oracleInfo);
      await manager.insert(DapiEntity, entity);
    });
  }
}
