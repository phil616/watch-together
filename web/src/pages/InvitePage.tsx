import { useEffect, useState, type FormEvent } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { api, json } from "../api/client";
import { useAuth } from "../auth/AuthContext";
import { Layout } from "../components/Layout";
import type { Room } from "../types";

/** Invitation landing page for joining a private room. */
export function InvitePage() {
  const { token = "" } = useParams();
  const { identity, refresh } = useAuth();
  const [info, setInfo] = useState<{ roomCode: string; roomTitle: string }>();
  const [error, setError] = useState("");
  const nav = useNavigate();

  useEffect(() => {
    api<{ roomCode: string; roomTitle: string }>(
      `/api/v1/invites/${encodeURIComponent(token)}/info`,
    )
      .then(setInfo)
      .catch((e) => setError(e.message));
  }, [token]);

  /** Join the room using the invitation token and a nickname. */
  const join = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    try {
      const room = await api<Room>(
        `/api/v1/invites/${encodeURIComponent(token)}/join`,
        { method: "POST", body: json({ nickname: f.get("nickname") }) },
      );
      await refresh();
      nav(`/room/${room.code}`);
    } catch (e) {
      setError((e as Error).message);
    }
  };
  return (
    <Layout>
      <div className="invite-wrap">
        <div className="invite-ticket">
          <span className="eyebrow">PRIVATE INVITATION</span>
          <h1>{info?.roomTitle ?? "正在验证邀请…"}</h1>
          {info && (
            <p>
              房间代码 <strong>{info.roomCode}</strong>
            </p>
          )}
          <div className="ticket-rule" />
          <form onSubmit={join}>
            {!identity && (
              <label>
                观影昵称
                <input
                  name="nickname"
                  required
                  maxLength={60}
                  autoFocus
                  placeholder="大家会看到这个名字"
                />
              </label>
            )}
            {error && <div className="error-box">{error}</div>}
            <button className="primary" disabled={!info}>
              {identity ? `以 ${identity.nickname} 身份加入` : "进入放映室"}
            </button>
          </form>
        </div>
      </div>
    </Layout>
  );
}
