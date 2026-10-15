import { IconTicket, IconArrowRight } from "@tabler/icons-react";
import {
  Button,
  TextInput,
  Paper,
  Alert,
  ThemeIcon,
  Badge,
  Text,
} from "@mantine/core";
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
  const [joining, setJoining] = useState(false);
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
    setJoining(true);
    try {
      const room = await api<Room>(
        `/api/v1/invites/${encodeURIComponent(token)}/join`,
        { method: "POST", body: json({ nickname: f.get("nickname") }) },
      );
      await refresh();
      nav(`/room/${room.code}`);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setJoining(false);
    }
  };
  return (
    <Layout>
      <div className="invite-wrap">
        <Paper className="invite-ticket">
          <ThemeIcon size={64} radius="xl" variant="light" mb="xl">
            <IconTicket size={32} stroke={1.4} />
          </ThemeIcon>
          <Badge variant="light">一张留给你的电影票</Badge>
          <h1>{info?.roomTitle ?? "正在验证邀请…"}</h1>
          {info && (
            <p>
              房间代码 <strong>{info.roomCode}</strong>
            </p>
          )}
          <Text size="sm" c="dimmed">
            好位置已经留好，就等你入场。
          </Text>
          <div className="ticket-rule" />
          <form onSubmit={join}>
            {!identity && (
              <TextInput
                label="观影昵称"
                name="nickname"
                required
                maxLength={60}
                autoFocus
                placeholder="大家会看到这个名字"
              />
            )}
            {error && (
              <Alert color="red" title="操作未完成" role="alert">
                {error}
              </Alert>
            )}
            <Button
              variant="filled"
              fullWidth
              type="submit"
              disabled={!info}
              loading={joining}
              rightSection={<IconArrowRight size={16} />}
            >
              {identity ? `以 ${identity.nickname} 身份加入` : "进入放映室"}
            </Button>
          </form>
        </Paper>
      </div>
    </Layout>
  );
}
