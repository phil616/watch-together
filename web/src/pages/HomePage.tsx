import {
  Alert,
  Badge,
  Button,
  Card,
  FileButton,
  Group,
  Paper,
  SimpleGrid,
  Skeleton,
  Stack,
  Text,
  TextInput,
  ThemeIcon,
  Title,
} from "@mantine/core";
import {
  IconArrowRight,
  IconCloudUpload,
  IconDeviceTv,
  IconMovie,
  IconPlus,
  IconTrash,
  IconUsers,
  IconSearch,
  IconCheck,
  IconPlayerPlay,
} from "@tabler/icons-react";
import { confirmAction } from "../components/confirmAction";
import { useEffect, useRef, useState, type FormEvent } from "react";
import { useNavigate } from "react-router-dom";
import { api, json } from "../api/client";
import { uploadMedia } from "../api/upload";
import { useAuth } from "../auth/AuthContext";
import { Layout } from "../components/Layout";
import type { Media, Room } from "../types";

const roomStatusLabel = (status: Room["status"]) => {
  if (status === "OPEN") return "开放中";
  if (status === "HOST_DISCONNECTED") return "等待房主返回";
  return "已关闭，可重新开放";
};

/** Dashboard for creating rooms and uploading media. */
export function HomePage() {
  const { identity, loading } = useAuth();
  const nav = useNavigate();
  const [rooms, setRooms] = useState<Room[]>([]);
  const [media, setMedia] = useState<Media[]>([]);
  const [error, setError] = useState("");
  const [uploading, setUploading] = useState("");
  const [busy, setBusy] = useState(false);
  const [creating, setCreating] = useState(false);
  const [listing, setListing] = useState(true);
  const [search, setSearch] = useState("");
  const resetFile = useRef<(() => void) | null>(null);
  const uploadController = useRef<AbortController | null>(null);
  const [storageHealth, setStorageHealth] = useState("");
  const [checkingStorage, setCheckingStorage] = useState(false);
  useEffect(() => () => uploadController.current?.abort(), []);
  const checkStorage = async () => {
    setCheckingStorage(true);
    setStorageHealth("正在检测 OSS…");
    try {
      const result = await api<{ message: string }>("/api/v1/storage/health", {
        signal: AbortSignal.timeout(10_000),
      });
      setStorageHealth(result.message);
    } catch (e) {
      setStorageHealth(
        (e as Error).name === "TimeoutError"
          ? "OSS 健康检测超时"
          : (e as Error).message,
      );
    } finally {
      setCheckingStorage(false);
    }
  };

  /** Reload both room and media lists from the API. */
  const load = () =>
    Promise.all([api<Room[]>("/api/v1/rooms"), api<Media[]>("/api/v1/media")])
      .then(([r, m]) => {
        setRooms(r ?? []);
        setMedia(m ?? []);
      })
      .catch((e) => setError(e.message))
      .finally(() => setListing(false));
  useEffect(() => {
    if (!loading && !identity) nav("/login");
    else if (identity && !identity.guest) load();
  }, [identity, loading]);
  if (loading || !identity) return null;
  if (identity.guest)
    return (
      <Layout>
        <section className="hero">
          <h1>你的游客会话仍然有效</h1>
          <p>请从邀请链接返回房间，或退出后登录正式账户。</p>
        </section>
      </Layout>
    );
  const create = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    setCreating(true);
    setError("");
    try {
      const r = await api<Room>("/api/v1/rooms", {
        method: "POST",
        body: json({
          title: f.get("title"),
          maxMembers: Number(f.get("maxMembers")),
        }),
      });
      nav(`/room/${r.code}`);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setCreating(false);
    }
  };
  const removeMedia = async (id: string) => {
    if (
      !(await confirmAction(
        "删除影片",
        "这部影片及对象存储中的文件将被永久删除。",
      ))
    )
      return;
    try {
      await api(`/api/v1/media/${id}`, { method: "DELETE" });
      await load();
    } catch (e) {
      setError((e as Error).message);
    }
  };
  /** Upload a selected file directly to object storage from the browser. */
  const upload = async (file: File | null) => {
    if (!file || uploadController.current) return;
    const controller = new AbortController();
    uploadController.current = controller;
    setBusy(true);
    setError("");
    try {
      await uploadMedia(file, controller.signal, setUploading);
    } catch (e) {
      setError((e as Error).message);
      setUploading("");
    } finally {
      uploadController.current = null;
      setBusy(false);
      resetFile.current?.();
      await load();
    }
  };
  const filteredMedia = media.filter((m) =>
    m.originalFilename.toLowerCase().includes(search.toLowerCase()),
  );
  return (
    <Layout>
      <section className="dashboard-hero">
        <div>
          <Badge variant="light" leftSection={<IconDeviceTv size={13} />}>
            你的私人影院
          </Badge>
          <h1>今晚，看点什么？</h1>
          <Text c="dimmed">把喜欢的电影和想念的人，放在同一个房间。</Text>
        </div>
        <div className="dashboard-stats">
          <div>
            <strong>{rooms.length.toString().padStart(2, "0")}</strong>
            <span>我的房间</span>
          </div>
          <div>
            <strong>{media.length.toString().padStart(2, "0")}</strong>
            <span>影片收藏</span>
          </div>
        </div>
      </section>
      {error && (
        <Alert
          color="red"
          title="操作未完成"
          role="alert"
          withCloseButton
          onClose={() => setError("")}
          mb="lg"
        >
          {error}
        </Alert>
      )}
      <div className="dashboard-grid">
        <Paper component="form" onSubmit={create} className="create-panel">
          <Group gap="sm" mb="lg">
            <ThemeIcon variant="light" size={42} radius="md">
              <IconPlus size={23} />
            </ThemeIcon>
            <div>
              <Title order={2} size="h4">
                新建房间
              </Title>
              <Text size="xs" c="dimmed">
                准备好，邀请朋友来坐坐
              </Text>
            </div>
          </Group>
          <Stack gap="md">
            <TextInput
              label="房间标题"
              name="title"
              placeholder="周五夜场"
              maxLength={100}
              required
            />
            <TextInput
              label="最多人数"
              name="maxMembers"
              type="number"
              min={2}
              max={20}
              defaultValue={8}
            />
            <Button
              type="submit"
              fullWidth
              loading={creating}
              rightSection={<IconArrowRight size={17} />}
            >
              创建并进入
            </Button>
          </Stack>
        </Paper>
        <Paper className="upload-panel">
          <Group gap="sm" mb="lg">
            <ThemeIcon variant="light" size={42} radius="md" color="blue">
              <IconMovie size={23} />
            </ThemeIcon>
            <div>
              <Title order={2} size="h4">
                影片资料库
              </Title>
              <Text size="xs" c="dimmed">
                为下一场放映做好准备
              </Text>
            </div>
          </Group>
          <div className="upload-zone">
            <ThemeIcon variant="transparent" size={50} color="gray">
              <IconCloudUpload size={38} stroke={1.3} />
            </ThemeIcon>
            <Text fw={600} mt="sm">
              好电影，值得一起看
            </Text>
            <Text size="xs" c="dimmed" mt={5} mb="md">
              支持 MP4、WebM 等浏览器可播放的视频
            </Text>
            <FileButton
              onChange={(file) => void upload(file)}
              accept="video/*"
              resetRef={resetFile}
            >
              {(props) => (
                <Button
                  {...props}
                  variant="light"
                  loading={busy}
                  leftSection={<IconPlus size={16} />}
                >
                  选择影片上传
                </Button>
              )}
            </FileButton>
          </div>
          {uploading && (
            <Text size="sm" c="amber" mt="sm" role="status">
              {uploading}
            </Text>
          )}
          <Group justify="space-between" mt="md">
            <Text size="xs" c="dimmed">
              私有存储 · 浏览器直传
            </Text>
            {busy ? (
              <Button
                variant="subtle"
                size="compact-xs"
                color="red"
                onClick={() => uploadController.current?.abort()}
              >
                取消上传
              </Button>
            ) : (
              <Button
                variant="subtle"
                color="gray"
                size="compact-xs"
                loading={checkingStorage}
                onClick={checkStorage}
              >
                检测 OSS 连接
              </Button>
            )}
          </Group>
          {storageHealth && (
            <Text size="xs" c="dimmed" mt="sm" role="status">
              {storageHealth}
            </Text>
          )}
        </Paper>
      </div>
      <section className="library">
        <Group justify="space-between" mb="lg">
          <Group gap="xs">
            <IconDeviceTv size={21} />
            <Title order={2} size="h4">
              我的房间
            </Title>
            <Badge variant="light" color="gray">
              {rooms.length} 间
            </Badge>
          </Group>
          <Text size="xs" c="dimmed">
            随时回来，继续相聚
          </Text>
        </Group>
        <SimpleGrid cols={{ base: 1, sm: 2, lg: 3 }} spacing="md">
          {listing
            ? [1, 2, 3].map((i) => <Skeleton key={i} h={128} radius="lg" />)
            : rooms.map((r) => (
                <Paper
                  key={r.id}
                  component="button"
                  onClick={() => nav(`/room/${r.code}`)}
                  className="room-card"
                  p="lg"
                >
                  <Group justify="space-between" mb="md">
                    <Badge
                      color={r.status === "OPEN" ? "teal" : "gray"}
                      variant="light"
                      size="sm"
                    >
                      {roomStatusLabel(r.status)}
                    </Badge>
                    <IconArrowRight size={18} className="room-arrow" />
                  </Group>
                  <Text fw={600} truncate ta="left">
                    {r.title}
                  </Text>
                  <Group justify="space-between" mt={8}>
                    <Text size="xs" c="dimmed" ff="monospace">
                      {r.code}
                    </Text>
                    <Group gap={4}>
                      <IconUsers size={13} />
                      <Text size="xs" c="dimmed">
                        最多 {r.maxMembers} 人
                      </Text>
                    </Group>
                  </Group>
                </Paper>
              ))}
        </SimpleGrid>
        {!listing && !rooms.length && (
          <EmptyLibrary
            icon="room"
            title="第一场放映，从这里开始"
            description="在上方创建房间，再把邀请链接发给朋友。"
          />
        )}
      </section>
      <section className="library">
        <Group justify="space-between" gap="sm" mb="lg">
          <Group gap="xs">
            <IconMovie size={21} />
            <Title order={2} size="h4">
              我的影片
            </Title>
            <Badge variant="light" color="gray">
              {media.length} 部
            </Badge>
          </Group>
          <TextInput
            aria-label="搜索影片"
            placeholder="搜索影片…"
            size="sm"
            leftSection={<IconSearch size={15} />}
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="media-search"
          />
        </Group>
        <SimpleGrid cols={{ base: 1, xs: 2, md: 3, lg: 4 }} spacing="md">
          {listing
            ? [1, 2, 3, 4].map((i) => <Skeleton key={i} h={230} radius="lg" />)
            : filteredMedia.map((m) => (
                <Card
                  withBorder
                  radius="lg"
                  p="md"
                  key={m.id}
                  className="media-card"
                >
                  <Card.Section className="poster-placeholder">
                    <IconMovie size={44} stroke={1} />
                    <Badge
                      className="poster-badge"
                      color={m.status === "READY" ? "teal" : "gray"}
                      size="xs"
                      variant="light"
                      leftSection={
                        m.status === "READY" ? (
                          <IconCheck size={11} />
                        ) : undefined
                      }
                    >
                      {m.status === "READY" ? "可放映" : m.status}
                    </Badge>
                  </Card.Section>
                  <Text
                    size="sm"
                    fw={600}
                    lineClamp={2}
                    mt="md"
                    title={m.originalFilename}
                  >
                    {m.originalFilename}
                  </Text>
                  <Group justify="space-between" mt="auto" pt="sm">
                    <Text size="xs" c="dimmed">
                      {(m.sizeBytes / 1024 / 1024).toFixed(1)} MB
                    </Text>
                    <Button
                      variant="subtle"
                      color="red"
                      size="compact-xs"
                      leftSection={<IconTrash size={13} />}
                      onClick={() => removeMedia(m.id)}
                    >
                      删除影片
                    </Button>
                  </Group>
                </Card>
              ))}
        </SimpleGrid>
        {!listing && !filteredMedia.length && (
          <EmptyLibrary
            icon="movie"
            title={search ? "没有找到匹配的影片" : "这里即将收藏你的好片"}
            description={
              search
                ? "试试其他关键词。"
                : "上传第一部影片，和朋友开启一场同步放映。"
            }
          />
        )}
      </section>
    </Layout>
  );
}

function EmptyLibrary({
  icon,
  title,
  description,
}: {
  icon: "room" | "movie";
  title: string;
  description: string;
}) {
  return (
    <Paper className="empty-library" p="xl">
      <ThemeIcon size={48} radius="xl" variant="light" color="gray">
        {icon === "room" ? (
          <IconDeviceTv size={24} />
        ) : (
          <IconPlayerPlay size={24} />
        )}
      </ThemeIcon>
      <Text fw={600} mt="md">
        {title}
      </Text>
      <Text size="sm" c="dimmed" mt={5}>
        {description}
      </Text>
    </Paper>
  );
}
