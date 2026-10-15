import { Button, TextInput, PasswordInput, Paper, Alert } from "@mantine/core";
import { useState, type FormEvent } from "react";
import { useNavigate } from "react-router-dom";
import { api, json } from "../api/client";
import { useAuth } from "../auth/AuthContext";

/** Managed accounts can sign in; account creation is restricted to the admin. */
export function AuthPage() {
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const { refresh } = useAuth();
  const nav = useNavigate();

  /** Sign in and refresh the current identity. */
  const submit = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    setBusy(true);
    setError("");
    const f = new FormData(e.currentTarget);
    try {
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
    <main className="auth-wrap">
      <Paper
        component="form"
        className="auth-panel"
        aria-label="登录"
        onSubmit={submit}
      >
        <h1>登录</h1>
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
          autoComplete="current-password"
        />
        {error && (
          <Alert color="red" title="操作未完成" role="alert">
            {error}
          </Alert>
        )}
        <Button variant="filled" fullWidth type="submit" loading={busy}>
          登录
        </Button>
      </Paper>
    </main>
  );
}
