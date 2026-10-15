import type { SyncController } from "./SyncController";

/** Route UI writes to the room, while giving the synchronizer direct media access.
 * Native media events are deliberately never translated into room commands.
 */
export function connectPlayer(
  video: HTMLVideoElement,
  controller: SyncController,
) {
  const prototype = HTMLMediaElement.prototype;
  const time = Object.getOwnPropertyDescriptor(prototype, "currentTime")!;
  const rate = Object.getOwnPropertyDescriptor(prototype, "playbackRate")!;
  const play = video.play.bind(video);
  const pause = video.pause.bind(video);
  const direct = new Proxy(video, {
    get(target, key) {
      if (key === "play") return play;
      if (key === "pause") return pause;
      if (key === "currentTime") return time.get!.call(target);
      if (key === "playbackRate") return rate.get!.call(target);
      const value = Reflect.get(target, key, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
    set(target, key, value) {
      if (key === "currentTime") time.set!.call(target, value);
      else if (key === "playbackRate") rate.set!.call(target, value);
      else Reflect.set(target, key, value, target);
      return true;
    },
  });
  video.play = () => controller.onUserPlay().catch(() => {});
  video.pause = () => {
    void controller.onUserPause().catch(() => {});
  };
  Object.defineProperties(video, {
    currentTime: {
      configurable: true,
      get: () => time.get!.call(video),
      set: (seconds: number) => {
        void controller.onUserSeek(seconds * 1000).catch(() => {});
      },
    },
    playbackRate: {
      configurable: true,
      get: () => rate.get!.call(video),
      set: (value: number) => {
        void controller.onUserRateChange(value).catch(() => {});
      },
    },
  });
  controller.attach(direct);
  return () => {
    controller.destroy();
    delete (video as Partial<HTMLVideoElement>).currentTime;
    delete (video as Partial<HTMLVideoElement>).playbackRate;
    video.play = play;
    video.pause = pause;
  };
}
