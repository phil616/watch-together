import type { ReactNode } from "react";
import { Link, useNavigate } from "react-router-dom";
import { useAuth } from "../auth/AuthContext";

export function Layout({
  children,
  wide = false,
}: {
  children: ReactNode;
  wide?: boolean;
}) {
  const { identity, logout } = useAuth();
  const navigate = useNavigate();

  return (
    <div className="app-shell">
      <header className="topbar">
        <Link to="/" className="brand">
          远程放映室
        </Link>
        <div className="topbar-side">
          {identity && (
            <>
              <span className="user-chip">
                {identity.nickname}
                {identity.guest ? " · 游客" : ""}
              </span>
              <button
                className="ghost small"
                onClick={() => logout().then(() => navigate("/login"))}
              >
                退出
              </button>
            </>
          )}
        </div>
      </header>
      <main className={wide ? "wide-container" : "container"}>{children}</main>
    </div>
  );
}
