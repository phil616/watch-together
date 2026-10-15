import type { ReactNode } from "react";
import { Link, useNavigate } from "react-router-dom";
import { Avatar, Badge, Button, Group, Text, ThemeIcon } from "@mantine/core";
import { IconMovie, IconLogout } from "@tabler/icons-react";
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
        <Link to="/" className="brand" aria-label="远程放映室首页">
          <ThemeIcon size={36} radius="md" variant="light">
            <IconMovie size={23} />
          </ThemeIcon>
          <span>
            远程放映室
            <Text component="span" className="brand-caption">
              WATCH TOGETHER
            </Text>
          </span>
        </Link>
        <Group gap="sm" wrap="nowrap">
          {identity ? (
            <>
              <Avatar color="amber" radius="xl" size={30}>
                {identity.nickname.slice(0, 1)}
              </Avatar>
              <Text size="sm" className="user-chip" maw={140} truncate>
                {identity.nickname}
                {identity.guest ? " · 游客" : ""}
              </Text>
              <Button
                variant="subtle"
                color="gray"
                size="xs"
                leftSection={<IconLogout size={15} />}
                onClick={() => logout().then(() => navigate("/login"))}
              >
                退出
              </Button>
            </>
          ) : (
            <Badge variant="light" color="gray" className="header-badge">
              让相聚，不受距离限制
            </Badge>
          )}
        </Group>
      </header>
      <main className={wide ? "wide-container" : "container"}>{children}</main>
      {!wide && (
        <footer className="app-footer">
          远程放映室 <span>一起看见，同一时刻。</span>
        </footer>
      )}
    </div>
  );
}
