/**
 * Shows `path` with the user's home as `~`. The protocol only knows the rooms
 * home (e.g. `/Users/x/rooms`); its parent is taken as the user home. Paths
 * outside it (or a home whose parent is `/`) stay absolute.
 */
export function tildePath(path: string, roomsHome: string): string {
  const home = roomsHome.replace(/\/+$/, "");
  const cut = home.lastIndexOf("/");
  if (cut <= 0) return path;
  const userHome = home.slice(0, cut);
  return path.startsWith(userHome + "/") ? "~/" + path.slice(userHome.length + 1) : path;
}
