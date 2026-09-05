import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  isCreativeMode,
  isSurvivalMode,
  needsOrphanRestore,
  parseMode,
  shouldBlockBannedPlace,
  shouldEnforceSurvival,
} from "../sapi/src/logic.ts";
import {
  DEFAULT_BANNED_ITEMS,
  FEATURE_ID,
  SLOT_CREATIVE,
  SLOT_SURVIVAL_BACKUP,
} from "../sapi/src/constants.ts";

describe("gamemode-area constants", () => {
  it("特性名与槽位约定", () => {
    assert.equal(FEATURE_ID, "gamemode");
    assert.equal(SLOT_SURVIVAL_BACKUP, "gamemode_survival_backup");
    assert.equal(SLOT_CREATIVE, "gamemode_creative");
    assert.ok(DEFAULT_BANNED_ITEMS.includes("minecraft:bedrock"));
  });
});

describe("gamemode-area logic", () => {
  it("解析 mode 参数", () => {
    assert.equal(parseMode({ mode: "Creative" }), "creative");
    assert.equal(isCreativeMode({ mode: "creative" }), true);
    assert.equal(isSurvivalMode({ mode: "survival" }), true);
    assert.equal(isCreativeMode({}), false);
  });

  it("孤儿还原条件（沙箱标记 + 非创造区）", () => {
    assert.equal(needsOrphanRestore(true, false), true);
    assert.equal(needsOrphanRestore(true, true), false);
    assert.equal(needsOrphanRestore(false, false), false);
  });

  it("创造区禁放判定", () => {
    assert.equal(
      shouldBlockBannedPlace({
        creativeChainEnabled: true,
        inCreativeSandbox: true,
        itemTypeId: "minecraft:tnt",
        bannedItems: DEFAULT_BANNED_ITEMS,
        canPlaceBanned: false,
      }),
      true,
    );
    assert.equal(
      shouldBlockBannedPlace({
        creativeChainEnabled: true,
        inCreativeSandbox: true,
        itemTypeId: "minecraft:tnt",
        bannedItems: DEFAULT_BANNED_ITEMS,
        canPlaceBanned: true,
      }),
      false,
    );
    assert.equal(
      shouldBlockBannedPlace({
        creativeChainEnabled: false,
        inCreativeSandbox: true,
        itemTypeId: "minecraft:tnt",
        bannedItems: DEFAULT_BANNED_ITEMS,
        canPlaceBanned: false,
      }),
      false,
    );
  });

  it("区外强制生存判定", () => {
    assert.equal(
      shouldEnforceSurvival({
        creativeChainEnabled: true,
        enforceOutside: true,
        inCreativeArea: false,
        hasBypass: false,
        gameMode: "Creative",
      }),
      true,
    );
    assert.equal(
      shouldEnforceSurvival({
        creativeChainEnabled: true,
        enforceOutside: true,
        inCreativeArea: true,
        hasBypass: false,
        gameMode: "Creative",
      }),
      false,
    );
    assert.equal(
      shouldEnforceSurvival({
        creativeChainEnabled: true,
        enforceOutside: true,
        inCreativeArea: false,
        hasBypass: true,
        gameMode: "Creative",
      }),
      false,
    );
  });
});
