import { invoke } from "@tauri-apps/api/core";
import { isTauri } from "./tauri";

export interface Connection {
  baseUrl: string;
  token: string;
  home: string;
}

declare global {
  interface Window {
    __ROOMS_DEV__?: Connection;
  }
}

export async function resolveConnection(): Promise<Connection> {
  if (isTauri()) return invoke<Connection>("connect");
  if (window.__ROOMS_DEV__) return window.__ROOMS_DEV__;
  throw new Error("Rooms 연결 정보가 없어요");
}
