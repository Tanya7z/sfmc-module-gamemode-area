/** 槽位与特性常量（与设计规格对齐）。 */

/** area.registerFeature 特性名 */
export const FEATURE_ID = "gamemode";

/** 生存背包隔离槽（inventory-switcher） */
export const SLOT_SURVIVAL_BACKUP = "gamemode_survival_backup";

/** 创造专用背包槽 */
export const SLOT_CREATIVE = "gamemode_creative";

/** 权限：区外保留创造/旁观豁免 */
export const PERM_BYPASS = "gamemode_area.bypass";

/** 权限：创造区放置黑名单物品 */
export const PERM_PLACE_BANNED = "gamemode_area.place_banned";

/** 创造沙箱状态标记（跨断线持久，用于孤儿恢复） */
export const TAG_CREATIVE_SANDBOX = "sfmc_gamemode_creative";

/** 默认禁放物品 */
export const DEFAULT_BANNED_ITEMS: readonly string[] = [
  "minecraft:bedrock",
  "minecraft:barrier",
  "minecraft:structure_block",
  "minecraft:tnt",
];
