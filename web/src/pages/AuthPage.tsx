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
          <span className="eyebrow">WATCH TOGETHER</span>
          <h1>
            距离很远，
            <br />
            画面仍在同一刻。
          </h1>
          <p>
            远程放映室允许使用S3-CDN加速影片来避免服务器带宽限制.
          </p>
        </section>
        <form className="panel auth-panel" onSubmit={submit}>
          <h2>{register ? "创建账户" : "欢迎回来"}</h2>
          <p className="muted">
            {register
              ? "注册后即可上传影片并创建房间"
              : "登录以继续你的观影房间"}
          </p>
          {register && (
            <label>
              昵称
              <input
                name="nickname"
                required
                maxLength={60}
                autoComplete="nickname"
              />
            </label>
          )}
          <label>
            用户名
            <input
              name="username"
              required
              minLength={3}
              maxLength={40}
              autoComplete="username"
            />
          </label>
          <label>
            密码
            <input
              name="password"
              type="password"
              required
              minLength={10}
              maxLength={256}
              autoComplete={register ? "new-password" : "current-password"}
            />
          </label>
          {error && <div className="error-box">{error}</div>}
          <button className="primary" disabled={busy}>
            {busy ? "请稍候…" : register ? "注册并登录" : "登录"}
          </button>
          <p className="switch-auth">
            {register ? "已有账户？" : "第一次来？"}{" "}
            <Link to={register ? "/login" : "/register"}>
              {register ? "直接登录" : "创建账户"}
            </Link>
          </p>
        </form>
      </div>
    </Layout>
  );
}
