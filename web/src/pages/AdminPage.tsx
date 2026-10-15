import { useEffect, useRef, useState, type FormEvent } from "react";
import { Link, Navigate, useSearchParams } from "react-router-dom";
import {
  ActionIcon,
  Alert,
  Badge,
  Button,
  Center,
  FileButton,
  Group,
  Loader,
  Modal,
  Pagination,
  Paper,
  PasswordInput,
  SimpleGrid,
  Skeleton,
  Stack,
  Switch,
  Table,
  Text,
  TextInput,
  ThemeIcon,
  Title,
  Tooltip,
} from "@mantine/core";
import { useDebouncedValue } from "@mantine/hooks";
import {
  IconArrowLeft,
  IconChartBar,
  IconDoor,
  IconEdit,
  IconMovie,
  IconPlus,
  IconRefresh,
  IconSearch,
  IconShieldLock,
  IconTrash,
  IconUpload,
  IconUsers,
} from "@tabler/icons-react";
import { api, json } from "../api/client";
import { uploadMedia } from "../api/upload";
import { useAuth } from "../auth/AuthContext";
import { Layout } from "../components/Layout";
import { confirmAction } from "../components/confirmAction";
import type { Media, Room } from "../types";

type User = {
  id: string;
  username: string;
  nickname: string;
  role: "USER" | "SUPER_ADMIN";
  disabled: boolean;
  createdAtMs: number;
  roomCount?: number;
  mediaCount?: number;
};
type ManagedRoom = Room & { ownerName: string };
type ManagedMedia = Media & {
  ownerName: string;
  ownerUserId: string;
  createdAtMs: number;
};
type Resource = User | ManagedRoom | ManagedMedia;
type PageData = {
  items: Resource[];
  total: number;
  page: number;
  perPage: number;
};
type Stats = {
  users: number;
  disabledUsers: number;
  rooms: number;
  openRooms: number;
  media: number;
  storageBytes: number;
};
type Section = "overview" | "users" | "rooms" | "media";
type Editor = { kind: Exclude<Section, "overview">; item?: Resource };
const sections = [
  {
    id: "overview",
    label: "系统概览",
    icon: IconChartBar,
    description: "掌握账户、放映室与片库的整体情况。",
  },
  {
    id: "users",
    label: "用户管理",
    icon: IconUsers,
    description: "由你分配账户，管理每一位观影者的访问权限。",
  },
  {
    id: "rooms",
    label: "房间管理",
    icon: IconDoor,
    description: "查看全站放映室，维护房间信息与开放状态。",
  },
  {
    id: "media",
    label: "影片管理",
    icon: IconMovie,
    description: "统一管理全站影片，整理片库与存储资源。",
  },
] as const;
const bytes = (v: number) =>
  v >= 1024 ** 3
    ? `${(v / 1024 ** 3).toFixed(1)} GB`
    : `${(v / 1024 ** 2).toFixed(1)} MB`;
const date = (v: number) =>
  new Date(v).toLocaleString("zh-CN", { hour12: false });
const message = (e: unknown) =>
  e instanceof Error ? e.message : "操作失败，请重试";

export function AdminPage() {
  const { identity, loading, refresh } = useAuth();
  const [params, setParams] = useSearchParams();
  const section: Section =
    sections.find((v) => v.id === params.get("section"))?.id ?? "overview";
  const [query, setQuery] = useState("");
  const [search] = useDebouncedValue(query, 250);
  const [page, setPage] = useState(1);
  const [revision, setRevision] = useState(0);
  const [stats, setStats] = useState<Stats | null>(null);
  const [data, setData] = useState<PageData>({
    items: [],
    total: 0,
    page: 1,
    perPage: 20,
  });
  const [busy, setBusy] = useState(false);
  const [acting, setActing] = useState(false);
  const [error, setError] = useState("");
  const [loadError, setLoadError] = useState("");
  const [success, setSuccess] = useState("");
  const [editor, setEditor] = useState<Editor | null>(null);
  const [uploadProgress, setUploadProgress] = useState("");
  const upload = useRef<AbortController | null>(null);
  const allowed = !identity?.guest && identity?.role === "SUPER_ADMIN";
  const reload = () => setRevision((v) => v + 1);

  useEffect(() => () => upload.current?.abort(), []);
  useEffect(() => {
    setPage(1);
    setQuery("");
    setError("");
    setSuccess("");
  }, [section]);
  useEffect(() => {
    if (!allowed) return;
    const controller = new AbortController();
    setBusy(true);
    setLoadError("");
    const work = async () => {
      try {
        const summary = await api<Stats>("/api/v1/admin/stats", {
          signal: controller.signal,
        });
        if (controller.signal.aborted) return;
        setStats(summary);
        if (section !== "overview") {
          const result = await api<PageData>(
            `/api/v1/admin/${section}?q=${encodeURIComponent(search)}&page=${page}`,
            { signal: controller.signal },
          );
          if (!controller.signal.aborted) {
            if (result.items.length === 0 && page > 1 && result.total > 0)
              setPage(Math.ceil(result.total / result.perPage));
            else setData(result);
          }
        }
      } catch (e) {
        if (!controller.signal.aborted) setLoadError(message(e));
      } finally {
        if (!controller.signal.aborted) setBusy(false);
      }
    };
    void work();
    return () => controller.abort();
  }, [allowed, section, search, page, revision]);

  if (loading)
    return (
      <Center mih="70vh">
        <Loader />
      </Center>
    );
  if (!identity) return <Navigate to="/login" replace />;
  if (!allowed)
    return (
      <Layout>
        <Paper>
          <Title order={2}>需要管理员权限</Title>
          <Text c="dimmed" my="md">
            管理后台仅对超级管理员开放。
          </Text>
          <Button component={Link} to="/">
            返回放映室
          </Button>
        </Paper>
      </Layout>
    );

  const action = async (
    path: string,
    method: string,
    title: string,
    detail: string,
  ) => {
    if (acting || !(await confirmAction(title, detail))) return;
    setActing(true);
    setError("");
    setSuccess("");
    try {
      await api(path, { method, ...(method === "POST" ? { body: "{}" } : {}) });
      setSuccess("操作已完成");
    } catch (e) {
      setError(message(e));
    } finally {
      setActing(false);
      reload();
    }
  };
  const beginUpload = async (file: File | null) => {
    if (!file || upload.current) return;
    const controller = new AbortController();
    upload.current = controller;
    setError("");
    setSuccess("");
    try {
      await uploadMedia(file, controller.signal, setUploadProgress);
      setSuccess("影片上传完成");
    } catch (e) {
      setError(message(e));
    } finally {
      upload.current = null;
      setUploadProgress("");
      reload();
    }
  };
  const current = sections.find((v) => v.id === section)!;
  const statsCards = [
    {
      label: "系统用户",
      value: stats?.users,
      detail: `${stats?.disabledUsers ?? 0} 个账户已禁用`,
      icon: IconUsers,
      color: "blue",
    },
    {
      label: "放映房间",
      value: stats?.rooms,
      detail: `${stats?.openRooms ?? 0} 个房间开放中`,
      icon: IconDoor,
      color: "teal",
    },
    {
      label: "全站影片",
      value: stats?.media,
      detail: "包含上传中与待整理的影片",
      icon: IconMovie,
      color: "amber",
    },
    {
      label: "影片总容量",
      value: stats ? bytes(stats.storageBytes) : undefined,
      detail: "按片库记录统计",
      icon: IconChartBar,
      color: "violet",
    },
  ];
  return (
    <Layout wide>
      <div className="admin-layout">
        <Paper className="admin-nav" p="md" component="aside">
          <Group gap="sm" mb="lg">
            <ThemeIcon variant="light" size={38}>
              <IconShieldLock size={22} />
            </ThemeIcon>
            <div>
              <Text fw={700}>管理中心</Text>
              <Text size="xs" c="dimmed">
                远程放映室
              </Text>
            </div>
          </Group>
          <nav aria-label="管理导航">
            <Stack gap={6}>
              {sections.map((v) => (
                <Button
                  key={v.id}
                  variant={section === v.id ? "light" : "subtle"}
                  color={section === v.id ? "amber" : "gray"}
                  justify="start"
                  leftSection={<v.icon size={18} />}
                  onClick={() => {
                    setPage(1);
                    setParams(v.id === "overview" ? {} : { section: v.id });
                  }}
                >
                  {v.label}
                </Button>
              ))}
            </Stack>
          </nav>
          <Text size="xs" c="dimmed" mt="xl">
            账户由管理员统一创建。
            <br />
            游客通过邀请链接加入。
          </Text>
          <Button
            component={Link}
            to="/"
            variant="subtle"
            color="gray"
            mt="md"
            leftSection={<IconArrowLeft size={15} />}
          >
            返回观影首页
          </Button>
        </Paper>
        <section className="admin-content">
          <Group justify="space-between" align="start" mb="xl">
            <div>
              <Badge variant="light" mb={8}>
                超级管理员
              </Badge>
              <Title order={1} size="h2">
                {current.label}
              </Title>
              <Text c="dimmed" size="sm" mt={6}>
                {current.description}
              </Text>
            </div>
            <Button
              variant="default"
              leftSection={<IconRefresh size={16} />}
              loading={busy}
              onClick={reload}
            >
              刷新数据
            </Button>
          </Group>
          {(error || loadError) && (
            <Alert color="red" title="操作未完成" role="alert" mb="md">
              {error || loadError}
            </Alert>
          )}
          {success && (
            <Alert
              color="teal"
              role="status"
              mb="md"
              withCloseButton
              onClose={() => setSuccess("")}
            >
              {success}
            </Alert>
          )}
          {uploadProgress && (
            <Alert color="blue" role="status" mb="md">
              <Group justify="space-between">
                <Text size="sm">{uploadProgress}</Text>
                <Button
                  size="xs"
                  variant="subtle"
                  onClick={() => upload.current?.abort()}
                >
                  取消上传
                </Button>
              </Group>
            </Alert>
          )}
          {section === "overview" ? (
            <>
              <SimpleGrid cols={{ base: 1, xs: 2, lg: 4 }} spacing="md">
                {statsCards.map((v) => (
                  <Paper key={v.label} p="lg">
                    <Group justify="space-between">
                      <Text size="sm" c="dimmed">
                        {v.label}
                      </Text>
                      <ThemeIcon color={v.color} variant="light">
                        <v.icon size={19} />
                      </ThemeIcon>
                    </Group>
                    {v.value === undefined ? (
                      <Skeleton h={36} my="md" />
                    ) : (
                      <Text fz={32} fw={700} my="sm">
                        {v.value}
                      </Text>
                    )}
                    <Text size="xs" c="dimmed">
                      {v.detail}
                    </Text>
                  </Paper>
                ))}
              </SimpleGrid>
              <Paper mt="xl">
                <Title order={2} size="h3">
                  管理你的私人放映空间
                </Title>
                <Text c="dimmed" size="sm" mt="sm" mb="lg">
                  创建账户、维护放映房间，或为下一场相聚准备影片。
                </Text>
                <Group>
                  <Button
                    leftSection={<IconPlus size={16} />}
                    onClick={() => setEditor({ kind: "users" })}
                  >
                    创建用户
                  </Button>
                  <Button
                    variant="light"
                    onClick={() => setParams({ section: "rooms" })}
                  >
                    查看全站房间
                  </Button>
                  <Button
                    variant="light"
                    onClick={() => setParams({ section: "media" })}
                  >
                    整理影片库
                  </Button>
                </Group>
              </Paper>
              <Paper mt="md">
                <Title order={3} size="h4">
                  访问规则
                </Title>
                <Text c="dimmed" size="sm" mt="sm">
                  超级管理员管理全站资源；普通用户可上传影片、创建房间并邀请好友。游客无需登录，仅可通过邀请链接进入指定房间。
                </Text>
              </Paper>
            </>
          ) : (
            <Paper p="lg" className="admin-resources">
              <Group justify="space-between" mb="lg" gap="md">
                <TextInput
                  aria-label="搜索管理资源"
                  placeholder={
                    section === "users"
                      ? "搜索用户名或昵称"
                      : section === "rooms"
                        ? "搜索房间标题或房间码"
                        : "搜索影片名称"
                  }
                  leftSection={<IconSearch size={17} />}
                  value={query}
                  onChange={(e) => {
                    setQuery(e.currentTarget.value);
                    setPage(1);
                  }}
                  className="admin-search"
                />
                {section === "media" ? (
                  <FileButton
                    onChange={(file) => void beginUpload(file)}
                    accept="video/*"
                  >
                    {(props) => (
                      <Button
                        {...props}
                        disabled={!!uploadProgress}
                        leftSection={<IconUpload size={16} />}
                      >
                        上传影片
                      </Button>
                    )}
                  </FileButton>
                ) : (
                  <Button
                    leftSection={<IconPlus size={16} />}
                    onClick={() => setEditor({ kind: section })}
                  >
                    {section === "users" ? "创建用户" : "创建房间"}
                  </Button>
                )}
              </Group>
              <Text size="xs" c="dimmed" mb="md">
                共 {data.total} 条记录
                {section === "media" ? " · 上传影片归当前管理员所有" : ""}
              </Text>
              {busy ? (
                <Stack aria-label="正在加载资源">
                  {[1, 2, 3, 4].map((v) => (
                    <Skeleton key={v} h={58} />
                  ))}
                </Stack>
              ) : data.items.length === 0 ? (
                <Center mih={220}>
                  <Stack align="center" gap="xs">
                    <current.icon size={36} />
                    <Text fw={600}>
                      {search ? "没有匹配的资源" : "暂无资源"}
                    </Text>
                    <Text size="sm" c="dimmed">
                      {search ? "试试其他关键词" : "使用上方按钮添加第一条记录"}
                    </Text>
                  </Stack>
                </Center>
              ) : (
                <Table.ScrollContainer
                  minWidth={section === "users" ? 740 : 680}
                >
                  <Table verticalSpacing="md" highlightOnHover>
                    <Table.Thead>
                      <Table.Tr>
                        {(section === "users"
                          ? ["用户", "权限与状态", "资源", "创建时间", "操作"]
                          : section === "rooms"
                            ? ["房间", "房主", "状态", "创建时间", "操作"]
                            : [
                                "影片",
                                "所有者",
                                "状态 / 容量",
                                "创建时间",
                                "操作",
                              ]
                        ).map((v) => (
                          <Table.Th key={v}>{v}</Table.Th>
                        ))}
                      </Table.Tr>
                    </Table.Thead>
                    <Table.Tbody>
                      {data.items.map((item) => {
                        const user = item as User;
                        const room = item as ManagedRoom;
                        const media = item as ManagedMedia;
                        const label =
                          section === "users"
                            ? user.username
                            : section === "rooms"
                              ? room.title
                              : media.originalFilename;
                        return (
                          <Table.Tr key={item.id}>
                            <Table.Td>
                              <Text fw={600} size="sm" maw={260} lineClamp={2}>
                                {section === "users" ? user.nickname : label}
                              </Text>
                              <Text size="xs" c="dimmed" mt={3}>
                                {section === "users"
                                  ? `@${user.username}`
                                  : section === "rooms"
                                    ? room.code
                                    : media.mimeType}
                              </Text>
                            </Table.Td>
                            <Table.Td>
                              {section === "users" ? (
                                <Stack gap={5} align="start">
                                  <Badge
                                    size="sm"
                                    variant="light"
                                    color={
                                      user.role === "SUPER_ADMIN"
                                        ? "amber"
                                        : "gray"
                                    }
                                  >
                                    {user.role === "SUPER_ADMIN"
                                      ? "超级管理员"
                                      : "普通用户"}
                                  </Badge>
                                  <Badge
                                    size="xs"
                                    variant="dot"
                                    color={user.disabled ? "red" : "teal"}
                                  >
                                    {user.disabled ? "已禁用" : "正常"}
                                  </Badge>
                                </Stack>
                              ) : (
                                <Text size="sm">
                                  {section === "rooms"
                                    ? room.ownerName
                                    : media.ownerName}
                                </Text>
                              )}
                            </Table.Td>
                            <Table.Td>
                              {section === "users" ? (
                                <Text size="xs" c="dimmed">
                                  {user.roomCount} 个房间 · {user.mediaCount}{" "}
                                  部影片
                                </Text>
                              ) : section === "rooms" ? (
                                <Badge
                                  variant="light"
                                  color={
                                    room.status === "CLOSED" ? "gray" : "teal"
                                  }
                                >
                                  {room.status === "CLOSED"
                                    ? "已关闭"
                                    : room.status === "OPEN"
                                      ? "开放中"
                                      : "等待房主"}
                                </Badge>
                              ) : (
                                <Stack gap={5} align="start">
                                  <Badge
                                    size="xs"
                                    variant="light"
                                    color={
                                      media.status === "READY" ? "teal" : "gray"
                                    }
                                  >
                                    {media.status === "READY"
                                      ? "可播放"
                                      : media.status}
                                  </Badge>
                                  <Text size="xs" c="dimmed">
                                    {bytes(media.sizeBytes)}
                                  </Text>
                                </Stack>
                              )}
                            </Table.Td>
                            <Table.Td>
                              <Text size="xs" c="dimmed">
                                {date(item.createdAtMs)}
                              </Text>
                            </Table.Td>
                            <Table.Td>
                              <Group gap={5} wrap="nowrap">
                                <Tooltip label="编辑">
                                  <ActionIcon
                                    variant="subtle"
                                    aria-label={`编辑 ${label}`}
                                    onClick={() =>
                                      setEditor({ kind: section, item })
                                    }
                                  >
                                    <IconEdit size={17} />
                                  </ActionIcon>
                                </Tooltip>
                                {section === "rooms" && (
                                  <Button
                                    variant="subtle"
                                    color={
                                      room.status === "CLOSED" ? "teal" : "gray"
                                    }
                                    size="compact-xs"
                                    disabled={acting}
                                    onClick={() =>
                                      void action(
                                        `/api/v1/admin/rooms/${item.id}/${room.status === "CLOSED" ? "reopen" : "close"}`,
                                        "POST",
                                        room.status === "CLOSED"
                                          ? "重新开放房间"
                                          : "关闭房间",
                                        room.status === "CLOSED"
                                          ? `重新开放「${label}」后，房主和成员可以再次进入。`
                                          : `关闭「${label}」将断开所有观影连接，游客邀请需重新进入。`,
                                      )
                                    }
                                  >
                                    {room.status === "CLOSED" ? "开放" : "关闭"}
                                  </Button>
                                )}
                                <Tooltip
                                  label={
                                    section === "users" &&
                                    user.role === "SUPER_ADMIN"
                                      ? "超级管理员不可删除"
                                      : "删除"
                                  }
                                >
                                  <ActionIcon
                                    variant="subtle"
                                    color="red"
                                    aria-label={`删除 ${label}`}
                                    disabled={
                                      acting ||
                                      (section === "users" &&
                                        user.role === "SUPER_ADMIN")
                                    }
                                    onClick={() =>
                                      void action(
                                        `/api/v1/admin/${section}/${item.id}`,
                                        "DELETE",
                                        `删除${section === "users" ? "用户" : section === "rooms" ? "房间" : "影片"}`,
                                        `确定删除「${label}」？${section === "users" ? "该用户持有的房间和影片需先处理。" : section === "rooms" ? "请先关闭房间。删除将清除成员、邀请和聊天记录。" : "使用中的影片需先停止使用。影片文件将一并清理。"}此操作无法撤销。`,
                                      )
                                    }
                                  >
                                    <IconTrash size={17} />
                                  </ActionIcon>
                                </Tooltip>
                              </Group>
                            </Table.Td>
                          </Table.Tr>
                        );
                      })}
                    </Table.Tbody>
                  </Table>
                </Table.ScrollContainer>
              )}
              <Group justify="space-between" mt="lg">
                <Text size="xs" c="dimmed">
                  每页 20 条
                </Text>
                <Pagination
                  value={page}
                  total={Math.max(1, Math.ceil(data.total / 20))}
                  onChange={setPage}
                  disabled={busy}
                  size="sm"
                />
              </Group>
            </Paper>
          )}
        </section>
      </div>
      <Modal
        opened={!!editor}
        onClose={() => {
          if (!acting) setEditor(null);
        }}
        title={
          editor
            ? `${editor.item ? "编辑" : "创建"}${editor.kind === "users" ? "用户" : editor.kind === "rooms" ? "房间" : "影片"}`
            : ""
        }
        centered
        closeOnClickOutside={!acting}
        closeOnEscape={!acting}
        withCloseButton={!acting}
      >
        {editor && (
          <ResourceEditor
            key={`${editor.kind}-${editor.item?.id ?? "new"}`}
            editor={editor}
            onCancel={() => setEditor(null)}
            onBusy={setActing}
            onSaved={async () => {
              setEditor(null);
              setSuccess("保存成功");
              reload();
              if (editor.kind === "users" && editor.item?.id === identity.id)
                await refresh();
            }}
          />
        )}
      </Modal>
    </Layout>
  );
}

function ResourceEditor({
  editor,
  onSaved,
  onCancel,
  onBusy,
}: {
  editor: Editor;
  onSaved: () => Promise<void>;
  onCancel: () => void;
  onBusy: (busy: boolean) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const user = editor.item as User | undefined;
  const [disabled, setDisabled] = useState(user?.disabled ?? false);
  const submit = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (busy) return;
    const f = new FormData(e.currentTarget);
    const body =
      editor.kind === "users"
        ? {
            username: f.get("username"),
            nickname: f.get("nickname"),
            disabled,
            ...(f.get("password") ? { password: f.get("password") } : {}),
          }
        : editor.kind === "rooms"
          ? { title: f.get("title") }
          : { originalFilename: f.get("filename") };
    setBusy(true);
    onBusy(true);
    setError("");
    try {
      await api(
        `/api/v1/admin/${editor.kind}${editor.item ? `/${editor.item.id}` : ""}`,
        { method: editor.item ? "PATCH" : "POST", body: json(body) },
      );
      await onSaved();
    } catch (e) {
      setError(message(e));
    } finally {
      setBusy(false);
      onBusy(false);
    }
  };
  return (
    <form onSubmit={submit}>
      <Stack gap="md">
        {editor.kind === "users" ? (
          <>
            <TextInput
              label="用户名"
              name="username"
              autoComplete="off"
              defaultValue={user?.username}
              minLength={3}
              maxLength={40}
              pattern="[a-zA-Z0-9._\-]+"
              description="3–40 位字母、数字、点、横线或下划线"
              required
            />
            <TextInput
              label="昵称"
              name="nickname"
              defaultValue={user?.nickname}
              maxLength={60}
              required
            />
            <PasswordInput
              label={user ? "重置密码" : "初始密码"}
              name="password"
              autoComplete="new-password"
              minLength={10}
              maxLength={256}
              required={!user}
              description={
                user
                  ? "留空保留原密码；填写时至少 10 位"
                  : "至少 10 位，请将凭据告知该用户"
              }
            />
            {user && (
              <Switch
                label="禁用账户"
                aria-label="禁用账户"
                checked={disabled}
                onChange={(e) => setDisabled(e.currentTarget.checked)}
                disabled={user.role === "SUPER_ADMIN"}
                description={
                  user.role === "SUPER_ADMIN"
                    ? "超级管理员账户始终保持启用"
                    : "禁用后立即撤销登录并断开实时连接"
                }
              />
            )}
            {user && (
              <Text size="xs" c="dimmed">
                保存后该账户需要重新登录；修改自己的账户也会退出当前会话。
              </Text>
            )}
          </>
        ) : editor.kind === "rooms" ? (
          <TextInput
            label="房间标题"
            name="title"
            defaultValue={(editor.item as Room | undefined)?.title}
            maxLength={100}
            required
            description={
              editor.item
                ? "更新后同步给房间中的成员"
                : "新房间归当前管理员所有"
            }
          />
        ) : (
          <TextInput
            label="影片名称"
            name="filename"
            defaultValue={(editor.item as Media)?.originalFilename}
            maxLength={255}
            required
          />
        )}
        {error && (
          <Alert color="red" role="alert">
            {error}
          </Alert>
        )}
        <Group justify="end">
          <Button variant="default" onClick={onCancel} disabled={busy}>
            取消
          </Button>
          <Button type="submit" loading={busy}>
            {editor.item ? "保存修改" : "确认创建"}
          </Button>
        </Group>
      </Stack>
    </form>
  );
}
