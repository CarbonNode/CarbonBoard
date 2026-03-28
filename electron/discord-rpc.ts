/**
 * Discord RPC Voice Mixer
 * Connects to local Discord client via IPC for per-user voice volume control.
 */

import { Client } from "@xhayper/discord-rpc";

const CLIENT_ID = "1462539019345858792";
const CLIENT_SECRET = "3FvEGLeU4uz7HbGQrXzIMQzFbSiEYK4Z";

let rpcClient: Client | null = null;
let connected = false;
let authenticated = false;

export interface VoiceUser {
  id: string;
  username: string;
  avatar: string | null;
  avatarUrl: string;
  volume: number; // 0-200
  mute: boolean;
  deaf: boolean;
  selfMute: boolean;
  selfDeaf: boolean;
  speaking: boolean;
}

export interface VoiceChannel {
  id: string;
  name: string;
  guildId: string;
  users: VoiceUser[];
}

export let lastError = "";

export async function connectDiscordRPC(): Promise<boolean> {
  if (connected && authenticated) return true;

  // Retry up to 3 times with 1s delay
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      // Clean up previous client
      if (rpcClient) {
        try { rpcClient.destroy(); } catch {}
        rpcClient = null;
      }

      rpcClient = new Client({ clientId: CLIENT_ID, clientSecret: CLIENT_SECRET });

      rpcClient.on("ready", () => {
        console.log("Discord RPC connected as", rpcClient?.user?.username);
        connected = true;
      });

      console.log(`Discord RPC login attempt ${attempt}/3...`);
      await rpcClient.login({
        scopes: ["rpc", "identify"],
        redirectUri: "http://localhost",
      } as any);

      authenticated = true;
      lastError = "";
      console.log("Discord RPC authenticated");
      return true;
    } catch (err: any) {
      lastError = err.message || "Unknown error";
      console.error(`Discord RPC attempt ${attempt} failed:`, lastError);
      connected = false;
      authenticated = false;
      if (attempt < 3) await new Promise(r => setTimeout(r, 1000));
    }
  }
  return false;
}

export async function getVoiceChannel(): Promise<VoiceChannel | null> {
  if (!rpcClient || !authenticated) return null;

  try {
    const channel: any = await rpcClient.request("GET_SELECTED_VOICE_CHANNEL", {});
    if (!channel || !channel.id) return null;

    const users: VoiceUser[] = (channel.voice_states || []).map((vs: any) => {
      const user = vs.user || {};
      const avatarHash = user.avatar;
      const avatarUrl = avatarHash
        ? `https://cdn.discordapp.com/avatars/${user.id}/${avatarHash}.png?size=128`
        : `https://cdn.discordapp.com/embed/avatars/${(parseInt(user.id) >> 22) % 6}.png`;

      return {
        id: user.id,
        username: user.global_name || user.username || "Unknown",
        avatar: avatarHash,
        avatarUrl,
        volume: vs.volume ?? 100,
        mute: vs.mute ?? false,
        deaf: vs.deaf ?? false,
        selfMute: vs.self_mute ?? false,
        selfDeaf: vs.self_deaf ?? false,
        speaking: false,
      };
    });

    return {
      id: channel.id,
      name: channel.name || "Voice Channel",
      guildId: channel.guild_id || "",
      users,
    };
  } catch (err: any) {
    console.error("Failed to get voice channel:", err.message);
    return null;
  }
}

export async function setUserVolume(userId: string, volume: number): Promise<boolean> {
  if (!rpcClient || !authenticated) return false;

  try {
    await rpcClient.request("SET_USER_VOICE_SETTINGS", {
      user_id: userId,
      volume: Math.max(0, Math.min(200, Math.round(volume))),
    });
    return true;
  } catch (err: any) {
    console.error("Failed to set user volume:", err.message);
    return false;
  }
}

export async function setUserMute(userId: string, mute: boolean): Promise<boolean> {
  if (!rpcClient || !authenticated) return false;

  try {
    await rpcClient.request("SET_USER_VOICE_SETTINGS", {
      user_id: userId,
      mute,
    });
    return true;
  } catch (err: any) {
    console.error("Failed to mute user:", err.message);
    return false;
  }
}

export function isConnected(): boolean {
  return connected && authenticated;
}

export async function disconnectDiscordRPC() {
  if (rpcClient) {
    try {
      rpcClient.destroy();
    } catch {}
    rpcClient = null;
    connected = false;
    authenticated = false;
  }
}
