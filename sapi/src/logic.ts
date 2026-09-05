/**
 * 创造链判定与禁放逻辑（纯函数，便于单测）。
 */

export type GamemodeParams = {
  mode?: string;
  enforce?: boolean;
};

/** 解析区域特性参数中的模式。 */
export function parseMode(params: Record<string, unknown> | GamemodeParams): string {
  const raw = (params as GamemodeParams).mode;
  return typeof raw === "string" ? raw.toLowerCase() : "";
}

/** 是否为创造沙箱区参数。 */
export function isCreativeMode(params: Record<string, unknown> | GamemodeParams): boolean {
  return parseMode(params) === "creative";
}

/** 是否为强制生存区参数。 */
export function isSurvivalMode(params: Record<string, unknown> | GamemodeParams): boolean {
  return parseMode(params) === "survival";
}

/**
 * 断线重连孤儿态：仍带有创造沙箱标记，且当前不在创造区时，需要安全还原。
 * （switch 离开后生存备份槽可能仍残留，不能仅凭 hasBackup 判定。）
 */
export function needsOrphanRestore(hasSandboxMark: boolean, inCreativeArea: boolean): boolean {
  return hasSandboxMark && !inCreativeArea;
}

/**
 * 创造区禁放：黑名单命中且无豁免权限时阻断。
 */
export function shouldBlockBannedPlace(opts: {
  creativeChainEnabled: boolean;
  inCreativeSandbox: boolean;
  itemTypeId: string;
  bannedItems: readonly string[];
  canPlaceBanned: boolean;
}): boolean {
  if (!opts.creativeChainEnabled) return false;
  if (!opts.inCreativeSandbox) return false;
  if (opts.canPlaceBanned) return false;
  const id = opts.itemTypeId.trim();
  if (!id) return false;
  return opts.bannedItems.includes(id);
}

/**
 * 区外强制生存：非豁免且处于创造/旁观时需要纠正。
 */
export function shouldEnforceSurvival(opts: {
  creativeChainEnabled: boolean;
  enforceOutside: boolean;
  inCreativeArea: boolean;
  hasBypass: boolean;
  gameMode: string;
}): boolean {
  if (!opts.creativeChainEnabled || !opts.enforceOutside) return false;
  if (opts.inCreativeArea || opts.hasBypass) return false;
  const gm = opts.gameMode;
  return gm === "Creative" || gm === "Spectator" || gm === "creative" || gm === "spectator";
}
