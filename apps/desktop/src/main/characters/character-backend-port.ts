import type { CharacterBackendPort } from '@shared/contracts'

/**
 * 角色读端口。
 *
 * 角色契约的完整接口仍由 shared/contracts/character.ts 统一维护；Main 这里只
 * 暴露读路径所需的最窄 GET 子集，避免 CharacterService 依赖传输 raw 类型或把
 * 传输层的通用能力扩散到角色领域。
 */
export type ReadonlyCharacterBackendPort = Pick<
  CharacterBackendPort,
  'getMe' | 'listCharacters' | 'getCharacter' | 'listCharacterRevisions' | 'getCharacterState'
>

/** 用户身份写入端口；角色 CRUD 由下方 FE-D1 端口负责。 */
export type CharacterIdentityWritePort = Pick<CharacterBackendPort, 'updateMe'>

/** FE-D1 角色写端口；继续复用 shared 冻结 DTO。 */
export type CharacterMutationPort = Pick<
  CharacterBackendPort,
  'createCharacter' | 'updateCharacter' | 'cloneCharacter' | 'archiveCharacter' | 'rollbackCharacter' | 'validateCharacter' | 'previewCharacter'
>

/** 角色实例演化写端口；命令/结果继续复用 shared 冻结契约。 */
export type CharacterEvolutionPort = Pick<CharacterBackendPort, 'resetCharacterEvolution'>

/** CharacterService 当前阶段所需最窄组合端口。 */
export type CharacterServiceBackendPort = ReadonlyCharacterBackendPort & CharacterIdentityWritePort & CharacterMutationPort & CharacterEvolutionPort
