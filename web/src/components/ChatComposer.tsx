import { Alert, Button, TextInput } from "@mantine/core";
import { IconSend } from "@tabler/icons-react";

export type ChatComposerState = {
  draft: string;
  disabled: boolean;
  sending: boolean;
  error: string;
  onDraftChange: (value: string) => void;
  onSend: () => Promise<void>;
};

/** Two entry points share a room draft and the same acknowledged send path. */
export function ChatComposer({
  chat,
  placement,
}: {
  chat: ChatComposerState;
  placement: "player" | "sidebar";
}) {
  const inPlayer = placement === "player";
  return (
    <div
      className={`chat-composer ${inPlayer ? "player-chat" : "sidebar-chat"}`}
    >
      {chat.error && (
        <Alert color="red" role="alert" p="xs">
          {chat.error}
        </Alert>
      )}
      <form
        className="chat-form"
        aria-label={inPlayer ? "播放器聊天" : "侧栏聊天"}
        onClick={inPlayer ? (event) => event.stopPropagation() : undefined}
        onKeyDown={(event) => {
          // Keep typing, arrows and spaces away from media shortcuts. IME Enter
          // confirms a Chinese candidate, rather than submitting the form.
          event.stopPropagation();
          if (
            event.key === "Enter" &&
            (event.nativeEvent.isComposing || event.keyCode === 229)
          )
            event.preventDefault();
        }}
        onSubmit={(event) => {
          event.preventDefault();
          void chat.onSend();
        }}
      >
        <TextInput
          size={inPlayer ? "xs" : "md"}
          aria-label={inPlayer ? "播放器消息输入" : "聊天消息"}
          name="message"
          maxLength={2000}
          autoComplete="off"
          placeholder={
            chat.disabled
              ? "等待重新连接…"
              : inPlayer
                ? "和房间里的朋友说点什么…"
                : "发送消息…"
          }
          value={chat.draft}
          onChange={(event) => chat.onDraftChange(event.currentTarget.value)}
          disabled={chat.disabled}
        />
        <Button
          size={inPlayer ? "compact-xs" : "sm"}
          type="submit"
          aria-label={inPlayer ? "播放器发送" : "发送消息"}
          disabled={chat.disabled || !chat.draft.trim()}
          loading={chat.sending}
        >
          <IconSend size={18} />
        </Button>
      </form>
    </div>
  );
}
