import { useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { VideoPlayer } from "../src/components/VideoPlayer";
import { RoomBroadcastStream } from "../src/realtime/RoomBroadcastStream";
import type { SyncController } from "../src/player/SyncController";
import "../src/styles.css";
const calls: unknown[] = [];
const broadcasts = new RoomBroadcastStream();
const controller = {
  attach(video: HTMLVideoElement) {
    Object.assign(window, { direct: video });
  },
  destroy() {
    calls.push("destroy");
  },
  setRoomState() {},
  async onUserPlay() {
    calls.push("play");
  },
  async onUserPause() {
    calls.push("pause");
  },
  async onUserSeek(value: number) {
    calls.push(["seek", value]);
  },
  async onUserRateChange(value: number) {
    calls.push(["rate", value]);
  },
};
function Fixture() {
  const sequence = useRef(0);
  const [status, setStatus] = useState(true);
  const [host, setHost] = useState(true);
  const [src, setSrc] = useState<string | undefined>(
    location.search.includes("empty") ? undefined : "/missing.mp4",
  );
  return (
    <>
      <button onClick={() => setHost(!host)}>切换身份</button>
      <button onClick={() => setSrc((src ?? "/missing.mp4") + "?new")}>
        切换来源
      </button>
      <button onClick={() => setSrc(undefined)}>移除影片</button>
      <button
        onClick={() =>
          broadcasts.receive({
            id: `broadcast-${sequence.current++}`,
            senderNickname: "测试用户",
            content: "聊天框实时广播",
          })
        }
      >
        发送测试广播
      </button>
      <VideoPlayer
        src={src}
        isHost={host}
        controller={controller as unknown as SyncController}
        syncStatus="synced"
        syncStatusVisible={status}
        broadcasts={broadcasts}
        onSyncStatusToggle={() => setStatus(!status)}
      />
    </>
  );
}
Object.assign(window, { calls, broadcasts });
createRoot(document.getElementById("root")!).render(<Fixture />);
