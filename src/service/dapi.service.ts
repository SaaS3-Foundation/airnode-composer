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

  async submitV2(dapi: DapiEntity): Promise<any> {
    const sponsorMnemonic = this.configService.get('SPONSOR_MNEMONIC');
    if (dapi.oracleInfo.targetChain.type == ChainType.EVM) {
      const artifact = phala.loadAnchorArtifact(
        this.configService.get('PHALA_ANCHOR_PATH'),
      );
      await phala.deployWithWeb3(
        dapi.oracleInfo.targetChain.httpProvider,
        sponsorMnemonic,
        artifact.abi,
        artifact.bytecode,
      );
      // await phala.configAnchor();
    }
    await this.dapiRepository.save(dapi);
    if (dapi.oracleInfo.sourceChain.type == ChainType.PHALA) {
      this.dapiRepository.updateStatus(
        dapi.id,
        JobStatus.DEPOLYING_SAAS3_DRUNTIME,
      );
      dapi.oracleInfo.address = await phala.deployFatContract(
        sponsorMnemonic,
        dapi.oracleInfo.sourceChain.clusterId,
        dapi.oracleInfo.sourceChain.wsProvider,
        dapi.oracleInfo.sourceChain.pruntime,
        this.configService.get('DRUNTIME_FAT_PATH'),
        {
          target_chain_rpc: dapi.oracleInfo.targetChain.httpProvider,
          anchor_contract_addr: 'TODO',
          web2_api_url_prefix: dapi.oracleInfo.web2Info.uri,
          api_key: '',
        },
      );
      dapi.status = JobStatus.DONE;
      await this.dapiRepository.update(dapi);
    }
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
