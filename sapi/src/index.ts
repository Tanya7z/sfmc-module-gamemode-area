/**
 * @sfmc-bds/module-gamemode-area — 区域游戏模式切换与背包隔离
 */

import {
  GameMode,
  Player,
  system,
  world,
  type EntityDieAfterEvent,
  type PlayerLeaveBeforeEvent,
  type PlayerPlaceBlockBeforeEvent,
  type PlayerSpawnAfterEvent,
} from "@minecraft/server";
import { config } from "@sfmc-bds/sdk/sapi/config";
import { ModuleRegistry } from "@sfmc-bds/sdk/module-loader";
import { debug, Msg, Permission } from "@sfmc-bds/sdk/sapi/runtime";
import { service } from "@sfmc-bds/sdk/sapi/service";
import {
  DEFAULT_BANNED_ITEMS,
  FEATURE_ID,
  PERM_BYPASS,
  PERM_PLACE_BANNED,
  SLOT_CREATIVE,
  SLOT_SURVIVAL_BACKUP,
  TAG_CREATIVE_SANDBOX,
} from "./constants.js";
import {
  isCreativeMode,
  isSurvivalMode,
  needsOrphanRestore,
  shouldBlockBannedPlace,
  shouldEnforceSurvival,
} from "./logic.js";

const MODULE_ID = "gamemode-area";

const unprovide: Array<() => void> = [];
const eventCleanups: Array<() => void> = [];

/** 当前处于创造沙箱（已 switch 至创造背包）的玩家。 */
const creativeSandbox = new Set<string>();

let creativeChainEnabled = true;
let enforceSurvivalOutside = true;
let bannedItems: string[] = [...DEFAULT_BANNED_ITEMS];

function safeGameMode(player: Player): string {
  try {
    return String(player.getGameMode());
  } catch {
    return "";
  }
}

function setSurvival(player: Player): void {
  try {
    player.setGameMode(GameMode.Survival);
  } catch (err) {
    debug.w(
      "GamemodeArea",
      `setSurvival 失败: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

function setCreative(player: Player): void {
  try {
    player.setGameMode(GameMode.Creative);
  } catch (err) {
    debug.w(
      "GamemodeArea",
      `setCreative 失败: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

function hasSandboxMark(player: Player): boolean {
  if (creativeSandbox.has(player.id)) return true;
  try {
    return player.hasTag(TAG_CREATIVE_SANDBOX);
  } catch {
    return false;
  }
}

function markSandbox(player: Player, on: boolean): void {
  try {
    if (on) {
      if (!player.hasTag(TAG_CREATIVE_SANDBOX))
        player.addTag(TAG_CREATIVE_SANDBOX);
      creativeSandbox.add(player.id);
    } else {
      if (player.hasTag(TAG_CREATIVE_SANDBOX))
        player.removeTag(TAG_CREATIVE_SANDBOX);
      creativeSandbox.delete(player.id);
    }
  } catch (err) {
    creativeSandbox.delete(player.id);
    debug.w(
      "GamemodeArea",
      `markSandbox 失败: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

async function invSwitch(
  playerId: string,
  fromSlotKey: string,
  toSlotKey: string,
): Promise<boolean> {
  try {
    const res = (await service.call("inventory.switch", {
      playerId,
      fromSlotKey,
      toSlotKey,
    })) as { ok?: boolean };
    return res?.ok === true;
  } catch (err) {
    debug.w(
      "GamemodeArea",
      `inventory.switch 失败: ${err instanceof Error ? err.message : String(err)}`,
    );
    return false;
  }
}

async function invHas(playerId: string, slotKey: string): Promise<boolean> {
  try {
    const res = (await service.call("inventory.has", {
      playerId,
      slotKey,
    })) as { exists?: boolean };
    return res?.exists === true;
  } catch {
    return false;
  }
}

async function invClear(playerId: string): Promise<void> {
  try {
    await service.call("inventory.clear", { playerId });
  } catch (err) {
    debug.w(
      "GamemodeArea",
      `inventory.clear 失败: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

async function invRestoreSurvival(playerId: string): Promise<void> {
  try {
    await service.call("inventory.restore", {
      playerId,
      slotKey: SLOT_SURVIVAL_BACKUP,
      clearAfter: true,
    });
  } catch (err) {
    debug.w(
      "GamemodeArea",
      `inventory.restore 失败: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

/** 进入创造沙箱：生存 → 创造槽，并切创造模式。 */
async function enterCreativeSandbox(player: Player): Promise<void> {
  if (!creativeChainEnabled) return;
  if (hasSandboxMark(player)) {
    markSandbox(player, true);
    setCreative(player);
    return;
  }
  const ok = await invSwitch(player.id, SLOT_SURVIVAL_BACKUP, SLOT_CREATIVE);
  if (!ok) {
    debug.w("GamemodeArea", `进入创造区背包切换失败 player=${player.id}`);
  }
  setCreative(player);
  markSandbox(player, true);
  Msg.tips("已进入创造区，生存背包已隔离", player);
}

/**
 * 离开创造沙箱：创造 → 生存槽，切回生存。
 * 用于正常出区、死亡、下线与异常移出。幂等：无沙箱标记则跳过 switch。
 */
async function leaveCreativeSandbox(
  player: Player,
  opts?: { silent?: boolean },
): Promise<void> {
  if (!hasSandboxMark(player)) {
    creativeSandbox.delete(player.id);
    return;
  }

  const hasBackup = await invHas(player.id, SLOT_SURVIVAL_BACKUP);
  const ok = await invSwitch(player.id, SLOT_CREATIVE, SLOT_SURVIVAL_BACKUP);
  if (!ok && hasBackup) {
    // switch 失败时兜底：清空当前创造物并还原生存备份
    await invClear(player.id);
    await invRestoreSurvival(player.id);
  }

  setSurvival(player);
  markSandbox(player, false);
  if (!opts?.silent) {
    Msg.tips("已离开创造区，生存背包已还原", player);
  }
}

/** 强制纠正为生存（生存区 / 区外强制）。 */
async function forceSurvival(player: Player): Promise<void> {
  if (!creativeChainEnabled) return;
  if (Permission.check(player, PERM_BYPASS)) return;

  if (hasSandboxMark(player)) {
    await leaveCreativeSandbox(player);
    return;
  }

  const gm = safeGameMode(player);
  if (
    shouldEnforceSurvival({
      creativeChainEnabled,
      enforceOutside: true,
      inCreativeArea: false,
      hasBypass: false,
      gameMode: gm,
    })
  ) {
    setSurvival(player);
  }
}

async function isInCreativeArea(player: Player): Promise<boolean> {
  try {
    const loc = player.location;
    const hit = (await service.call("area.byPoint", {
      dimension: player.dimension.id,
      x: loc.x,
      z: loc.z,
      feature: FEATURE_ID,
    })) as { features?: Record<string, unknown> } | null;
    if (!hit?.features) return false;
    const params = hit.features[FEATURE_ID];
    if (!params || typeof params !== "object") return false;
    return isCreativeMode(params as Record<string, unknown>);
  } catch {
    return false;
  }
}

/** 重登/异常：仍有沙箱标记且不在创造区 → 安全还原。 */
async function orphanRestoreIfNeeded(player: Player): Promise<void> {
  if (!creativeChainEnabled) return;
  const marked = hasSandboxMark(player);
  const inCreative = await isInCreativeArea(player);
  if (!needsOrphanRestore(marked, inCreative)) {
    // 仍在创造区但丢失内存集合：补标记并确保创造模式
    if (inCreative && marked) {
      markSandbox(player, true);
      setCreative(player);
    }
    return;
  }
  await leaveCreativeSandbox(player, { silent: true });
  Msg.tips("检测到异常创造状态，已安全还原生存背包", player);
}

/** 区外强制生存纠正。 */
async function enforceOutsideIfNeeded(player: Player): Promise<void> {
  if (!creativeChainEnabled || !enforceSurvivalOutside) return;
  if (Permission.check(player, PERM_BYPASS)) return;
  const inCreative = await isInCreativeArea(player);
  const gm = safeGameMode(player);
  if (
    !shouldEnforceSurvival({
      creativeChainEnabled,
      enforceOutside: enforceSurvivalOutside,
      inCreativeArea: inCreative,
      hasBypass: false,
      gameMode: gm,
    })
  ) {
    return;
  }
  await forceSurvival(player);
}

async function handleFeatureEnter(
  player: Player,
  params: Record<string, unknown>,
): Promise<void> {
  if (!creativeChainEnabled) return;
  if (isCreativeMode(params)) {
    await enterCreativeSandbox(player);
    return;
  }
  if (isSurvivalMode(params)) {
    await forceSurvival(player);
  }
}

async function handleFeatureLeave(
  player: Player,
  params: Record<string, unknown>,
): Promise<void> {
  if (isCreativeMode(params) || hasSandboxMark(player)) {
    await leaveCreativeSandbox(player);
  }
  // 离开后若仍在创造模式且开启区外强制，再纠正一次
  await enforceOutsideIfNeeded(player);
}

async function loadConfig(): Promise<void> {
  const chain = await config.get<boolean>("creative_chain_enabled");
  if (typeof chain === "boolean") creativeChainEnabled = chain;

  const enforce = await config.get<boolean>("enforce_survival_outside");
  if (typeof enforce === "boolean") enforceSurvivalOutside = enforce;

  const banned = await config.get<unknown>("banned_items");
  if (Array.isArray(banned)) {
    bannedItems = banned.filter(
      (x): x is string => typeof x === "string" && x.length > 0,
    );
  }
}

function registerFeatureSlot(): void {
  try {
    service.call("area.registerFeature", {
      id: FEATURE_ID,
      handler: {
        id: FEATURE_ID,
        onEnter(
          player: Player,
          _ctx: unknown,
          params: Record<string, unknown>,
        ) {
          void handleFeatureEnter(player, params ?? {}).catch((err) => {
            debug.w(
              "GamemodeArea",
              `onEnter: ${err instanceof Error ? err.message : String(err)}`,
            );
          });
        },
        onLeave(
          player: Player,
          _ctx: unknown,
          params: Record<string, unknown>,
        ) {
          void handleFeatureLeave(player, params ?? {}).catch((err) => {
            debug.w(
              "GamemodeArea",
              `onLeave: ${err instanceof Error ? err.message : String(err)}`,
            );
          });
        },
      },
    });
  } catch (err) {
    debug.w(
      "GamemodeArea",
      `area.registerFeature 失败: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

ModuleRegistry.register({
  id: MODULE_ID,
  afterWorldLoad: true,
  lifecycle: {
    registerPermissions() {
      // 设计：bypass=OP(3)→Admin；place_banned=Admin(2)→OP
      Permission.register(PERM_BYPASS, Permission.Admin);
      Permission.register(PERM_PLACE_BANNED, Permission.OP);
    },
    registerEvents() {
      // 禁放拦截（创造沙箱内）
      const placeCb = world.beforeEvents.playerPlaceBlock.subscribe(
        (ev: PlayerPlaceBlockBeforeEvent) => {
          if (!creativeChainEnabled) return;
          const player = ev.player;
          if (!hasSandboxMark(player)) return;
          let typeId = "";
          try {
            typeId = ev.permutationToPlace?.type?.id ?? "";
          } catch {
            typeId = "";
          }
          const block = shouldBlockBannedPlace({
            creativeChainEnabled,
            inCreativeSandbox: true,
            itemTypeId: typeId,
            bannedItems,
            canPlaceBanned: Permission.check(player, PERM_PLACE_BANNED),
          });
          if (!block) return;
          ev.cancel = true;
          // before 事件中延后发消息，避免同步副作用
          system.run(() => {
            Msg.warning(`创造区内禁止放置: ${typeId}`, player);
          });
        },
      );
      eventCleanups.push(() => {
        try {
          world.beforeEvents.playerPlaceBlock.unsubscribe(placeCb);
        } catch {
          /* ignore */
        }
      });

      // 死亡：安全还原模式与背包，防止创造物外泄
      const dieCb = world.afterEvents.entityDie.subscribe(
        (ev: EntityDieAfterEvent) => {
          const ent = ev.deadEntity;
          if (!(ent instanceof Player)) return;
          if (!hasSandboxMark(ent)) return;
          void leaveCreativeSandbox(ent, { silent: true }).catch((err) => {
            debug.w(
              "GamemodeArea",
              `death restore: ${err instanceof Error ? err.message : String(err)}`,
            );
          });
        },
      );
      eventCleanups.push(() => {
        try {
          world.afterEvents.entityDie.unsubscribe(dieCb);
        } catch {
          /* ignore */
        }
      });

      // 下线前尽早还原（area 也会 onLeave；此处双保险）
      const leaveCb = world.beforeEvents.playerLeave.subscribe(
        (ev: PlayerLeaveBeforeEvent) => {
          const player = ev.player;
          if (!hasSandboxMark(player)) return;
          void leaveCreativeSandbox(player, { silent: true }).catch((err) => {
            debug.w(
              "GamemodeArea",
              `leave restore: ${err instanceof Error ? err.message : String(err)}`,
            );
          });
        },
      );
      eventCleanups.push(() => {
        try {
          world.beforeEvents.playerLeave.unsubscribe(leaveCb);
        } catch {
          /* ignore */
        }
      });

      // 重登孤儿恢复 / 死亡后若仍在创造区则重新进入
      const spawnCb = world.afterEvents.playerSpawn.subscribe(
        (ev: PlayerSpawnAfterEvent) => {
          const player = ev.player;
          void (async () => {
            if (!creativeChainEnabled) return;
            const inCreative = await isInCreativeArea(player);
            if (inCreative) {
              await enterCreativeSandbox(player);
              return;
            }
            await orphanRestoreIfNeeded(player);
            await enforceOutsideIfNeeded(player);
          })().catch((err) => {
            debug.w(
              "GamemodeArea",
              `spawn: ${err instanceof Error ? err.message : String(err)}`,
            );
          });
        },
      );
      eventCleanups.push(() => {
        try {
          world.afterEvents.playerSpawn.unsubscribe(spawnCb);
        } catch {
          /* ignore */
        }
      });
    },
    async init() {
      await loadConfig();
      config.onChange((key) => {
        if (
          key === "creative_chain_enabled" ||
          key === "enforce_survival_outside" ||
          key === "banned_items"
        ) {
          void loadConfig();
        }
      });

      // area 在 afterWorldLoad init 中 provide；此处挂接特性（依赖启动顺序由平台 requires 保证）
      registerFeatureSlot();
      // 下一 tick 再试一次，避免同批 init 竞态
      system.run(() => registerFeatureSlot());

      unprovide.push(
        service.provide("gamemode.setCreativeChainEnabled", async (input) => {
          const enabled = Boolean(input.enabled);
          creativeChainEnabled = enabled;
          try {
            await config.set("creative_chain_enabled", enabled);
          } catch (err) {
            debug.w(
              "GamemodeArea",
              `写入 creative_chain_enabled 失败: ${err instanceof Error ? err.message : String(err)}`,
            );
          }
          return { ok: true };
        }),
      );
      unprovide.push(
        service.provide("gamemode.isCreativeChainEnabled", () => ({
          enabled: creativeChainEnabled,
        })),
      );

      // 在线玩家补扫：孤儿 / 区外创造
      for (const p of world.getAllPlayers()) {
        void orphanRestoreIfNeeded(p).then(() => enforceOutsideIfNeeded(p));
      }

      debug.i(
        "GamemodeArea",
        `init chain=${creativeChainEnabled} enforce=${enforceSurvivalOutside} banned=${bannedItems.length}`,
      );
    },
    cleanup() {
      for (const c of eventCleanups.splice(0, eventCleanups.length)) c();
      for (const u of unprovide.splice(0, unprovide.length)) u();
      creativeSandbox.clear();
      debug.i("GamemodeArea", "cleanup");
    },
  },
});
