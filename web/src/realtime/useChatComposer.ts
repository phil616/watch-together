import { useEffect, useMemo, useRef, useState } from "react";
import type { ChatComposerState } from "../components/ChatComposer";
import type { WebSocketClient } from "./WebSocketClient";

/** Shared room draft; one send at a time, no optimistic echo or automatic retry. */
export function useChatComposer(
  ws: Pick<WebSocketClient, "send">,
  connected: boolean,
): ChatComposerState {
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState("");
  const session = useMemo(() => ({ pending: false, revision: 0 }), [ws]);
  const active = useRef(session);
  active.current = session;
  useEffect(() => {
    setDraft("");
    setError("");
    setSending(false);
  }, [session]);
  return {
    draft,
    sending,
    error,
    disabled: !connected,
    onDraftChange(value) {
      session.revision++;
      setDraft(value);
      setError("");
    },
    async onSend() {
      if (
        !connected ||
        !draft.trim() ||
        session.pending ||
        active.current !== session
      )
        return;
      session.pending = true;
      const revision = session.revision;
      setSending(true);
      setError("");
      try {
        await ws.send("chat.send", { content: draft });
        // Do not erase the next message typed while awaiting the ACK, or a
        // different room's draft when the old request eventually completes.
        if (active.current === session && revision === session.revision)
          setDraft("");
      } catch (cause) {
        if (active.current === session)
          setError(
            cause instanceof Error ? cause.message : "消息发送失败，请重试",
          );
      } finally {
        session.pending = false;
        if (active.current === session) setSending(false);
      }
    },
  };
}
