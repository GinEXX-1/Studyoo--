import { useState, useEffect } from "react";
import { BrowserRouter as Router, Routes, Route, Navigate, useNavigate, useLocation } from "react-router-dom";
import { QueryClient, QueryClientProvider, useQueryClient } from "@tanstack/react-query";
import { Toaster } from "sonner";
import { apiRequest } from "./lib/api.js";
import AuthPanel from "./components/AuthPanel.jsx";
import ErrorBoundary from "./components/ErrorBoundary.jsx";
import HomePage from "./pages/HomePage.jsx";
import LibraryPage from "./pages/LibraryPage.jsx";
import PracticePage from "./pages/PracticePage.jsx";
import QuestionParser from "./pages/QuestionParser.jsx";
import ProfilePage from "./pages/ProfilePage.jsx";
import TodayPage from "./pages/TodayPage.jsx";
import ImportPage from "./pages/ImportPage.jsx";
import ReviewPage from "./pages/ReviewPage.jsx";
import "./styles.css";

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: 1,
      refetchOnWindowFocus: false,
    },
  },
});

function AppHeader({ user }) {
  const navigate = useNavigate();
  const location = useLocation();
  const currentPage = location.pathname.split("/")[1] || "home";

  return (
    <header className="app-header">
      <button className="brand" onClick={() => navigate("/")} aria-label="返回 Studyoo 工作台">
        <img src="/brand/studyoo-black.png" alt="Studyoo" />
      </button>
      <nav className="main-nav" aria-label="主导航">
        <button className={currentPage === "" || currentPage === "home" ? "active" : ""} onClick={() => navigate("/")}>工作台</button>
        <button className={currentPage === "today" ? "active" : ""} onClick={() => navigate("/today")}>今日计划</button>
        <button className={currentPage === "library" ? "active" : ""} onClick={() => navigate("/library")}>题库</button>
        <button className={currentPage === "parser" ? "active" : ""} onClick={() => navigate("/parser")}>解析</button>
      </nav>
      <button className="profile-chip" onClick={() => navigate("/profile")} aria-label={`${user.nickname} 的个人档案`}><span>{user.nickname.slice(0, 1).toUpperCase()}</span><strong>{user.nickname}</strong><em>个人档案</em></button>
    </header>
  );
}

function AppContent({ user, onUserUpdated, onLogout }) {
  const location = useLocation();
  const immersive = location.pathname.startsWith("/practice/") || location.pathname.startsWith("/review/");

  return (
    <div className={`app-shell${immersive ? " immersive-shell" : ""}`}>
      {!immersive && <AppHeader user={user} />}
      <div className="app-content">
        <Routes>
          <Route path="/" element={<HomePage />} />
          <Route path="/library" element={<LibraryPage />} />
          <Route path="/practice/:id" element={<PracticePage />} />
          <Route path="/parser" element={<QuestionParser />} />
          <Route path="/today" element={<TodayPage />} />
          <Route path="/profile" element={<ProfilePage user={user} onUserUpdated={onUserUpdated} onLogout={onLogout} />} />
          <Route path="/import" element={<ImportPage />} />
          <Route path="/review/:taskId" element={<ReviewPage />} />
        </Routes>
      </div>
    </div>
  );
}

function App() {
  const [user, setUser] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    apiRequest("/users/me")
      .then(setUser)
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);

  async function logout() {
    await apiRequest("/auth/logout", { method: "POST" });
    setUser(null);
  }

  if (loading) {
    return (
      <main className="auth-shell">
        <div style={{ textAlign: "center" }}>
          <p className="eyebrow">Studyoo</p>
          <h1>加载中...</h1>
        </div>
      </main>
    );
  }

  return (
    <QueryClientProvider client={queryClient}>
      <ErrorBoundary>
        <Router>
          {!user ? (
            <AuthPanel onSignedIn={setUser} />
          ) : (
            <AppContent user={user} onUserUpdated={setUser} onLogout={logout} />
          )}
        </Router>
      </ErrorBoundary>
      <Toaster
        position="top-right"
        toastOptions={{
          style: {
            background: "#ffffff",
            border: "1px solid #d9ddd7",
            borderRadius: "8px",
            boxShadow: "0 4px 20px rgba(0,0,0,0.1)",
          },
        }}
      />
    </QueryClientProvider>
  );
}

export default App;
