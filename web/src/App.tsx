import { Navigate, Route, Routes } from "react-router-dom";
import { lazy, Suspense } from "react";
import { Center, Loader } from "@mantine/core";
const AuthPage = lazy(() =>
  import("./pages/AuthPage").then((m) => ({ default: m.AuthPage })),
);
const HomePage = lazy(() =>
  import("./pages/HomePage").then((m) => ({ default: m.HomePage })),
);
const InvitePage = lazy(() =>
  import("./pages/InvitePage").then((m) => ({ default: m.InvitePage })),
);
const RoomPage = lazy(() =>
  import("./pages/RoomPage").then((m) => ({ default: m.RoomPage })),
);

const AdminPage = lazy(() =>
  import("./pages/AdminPage").then((m) => ({ default: m.AdminPage })),
);

/** Application routes. */
export default function App() {
  return (
    <Suspense
      fallback={
        <Center mih="70vh" role="status" aria-label="正在加载页面">
          <Loader size="sm" />
        </Center>
      }
    >
      <Routes>
        <Route path="/" element={<HomePage />} />
        <Route path="/login" element={<AuthPage />} />
        <Route path="/register" element={<Navigate to="/login" replace />} />
        <Route path="/admin" element={<AdminPage />} />
        <Route path="/join/:token" element={<InvitePage />} />
        <Route path="/room/:code" element={<RoomPage />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </Suspense>
  );
}
