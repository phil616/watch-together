import {
  IconPlayerPlay,
  IconUsers,
  IconLock,
  IconArrowRight,
} from "@tabler/icons-react";
import {
  Button,
  TextInput,
  PasswordInput,
  Paper,
  Alert,
  Badge,
  Group,
  ThemeIcon,
  Text,
} from "@mantine/core";
import { useState, type FormEvent } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { api, json } from "../api/client";
import { useAuth } from "../auth/AuthContext";
import { Layout } from "../components/Layout";

/** Login/register page. The route mode is either `login` or `register`. */
export function AuthPage() {
  const { mode = "login" } = useParams();
  const register = mode === "register";
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const { refresh } = useAuth();
  const nav = useNavigate();

  /** Submit registration (when needed), then sign in and refresh identity. */
  const submit = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    setBusy(true);
    setError("");
    const f = new FormData(e.currentTarget);
    try {
      if (register)
        await api("/api/v1/auth/register", {
          method: "POST",
          body: json({
            username: f.get("username"),
            password: f.get("password"),
            nickname: f.get("nickname"),
          }),
        });
      await api("/api/v1/auth/login", {
        method: "POST",
        body: json({
          username: f.get("username"),
          password: f.get("password"),
        }),
      });
      await refresh();
      nav("/");
    } catch (e) {
      setError(e instanceof Error ? e.message : "操作失败");
    } finally {
      setBusy(false);
    }
  };
  return (
    <Layout>
      <div className="auth-wrap">
        <section className="auth-copy">
          <Badge variant="light" leftSection={<IconPlayerPlay size={12} />}>
            跨越距离 · 一起放映
          </Badge>
          <h1>
            距离很远，
            <br />
            画面仍在同一刻。
          </h1>
          <p>
            一起按下播放，一起分享此刻。创建你的私人放映室，让电影里的每一秒，都有朋友在身边。
          </p>
          <Group gap="xl" mt="xl" className="auth-features">
            <Group gap={8}>
              <ThemeIcon variant="light" radius="xl" size={28}>
                <IconUsers size={16} />
              </ThemeIcon>
              <Text size="sm" c="dimmed">
                多人同步观影
              </Text>
            </Group>
            <Group gap={8}>
              <ThemeIcon variant="light" radius="xl" size={28}>
                <IconLock size={16} />
              </ThemeIcon>
              <Text size="sm" c="dimmed">
                专属邀请空间
              </Text>
            </Group>
          </Group>
        </section>
        <Paper component="form" className="auth-panel" onSubmit={submit}>
          <h2>{register ? "创建账户" : "欢迎回来"}</h2>
          <p className="muted">
            {register
              ? "注册后即可上传影片并创建房间"
              : "登录以继续你的观影房间"}
          </p>
          {register && (
            <TextInput
              label="昵称"
              name="nickname"
              required
              maxLength={60}
              autoComplete="nickname"
            />
          )}
          <TextInput
            label="用户名"
            name="username"
            required
            minLength={3}
            maxLength={40}
            autoComplete="username"
          />
          <PasswordInput
            size="md"
            visibilityToggleButtonProps={{ "aria-label": "显示或隐藏密码" }}
            label="密码"
            name="password"
            required
            minLength={10}
            maxLength={256}
            autoComplete={register ? "new-password" : "current-password"}
          />
          {error && (
            <Alert color="red" title="操作未完成" role="alert">
              {error}
            </Alert>
          )}
          <Button
            variant="filled"
            fullWidth
            type="submit"
            loading={busy}
            rightSection={<IconArrowRight size={16} />}
          >
            {register ? "注册并登录" : "登录"}
          </Button>
          <p className="switch-auth">
            {register ? "已有账户？" : "第一次来？"}{" "}
            <Link to={register ? "/login" : "/register"}>
              {register ? "直接登录" : "创建账户"}
            </Link>
          </p>
        </Paper>
      </div>
    </Layout>
  );
}
