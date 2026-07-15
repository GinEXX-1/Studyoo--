import { useEffect, useState } from "react";
import { toast } from "sonner";
import { apiRequest } from "../lib/api.js";

const categories = [
  ["experience", "使用体验"],
  ["bug", "问题报告"],
  ["content", "题目内容"],
  ["idea", "功能建议"],
  ["other", "其他"]
];

const statusLabels = { open: "已收到", reviewing: "处理中", resolved: "已解决" };

export default function AccountFeedback() {
  const [version, setVersion] = useState(null);
  const [items, setItems] = useState([]);
  const [category, setCategory] = useState("experience");
  const [message, setMessage] = useState("");
  const [sending, setSending] = useState(false);

  async function load() {
    const [versionData, feedbackData] = await Promise.all([
      apiRequest("/system/version"),
      apiRequest("/feedback/mine")
    ]);
    setVersion(versionData);
    setItems(feedbackData.items || []);
  }

  useEffect(() => {
    load().catch((error) => toast.error(error.message));
  }, []);

  async function submit(event) {
    event.preventDefault();
    setSending(true);
    try {
      await apiRequest("/feedback", { method: "POST", body: JSON.stringify({ category, message }) });
      setMessage("");
      await load();
      toast.success("反馈已送达，我们会在这里更新处理状态");
    } catch (error) {
      toast.error(error.message);
    } finally {
      setSending(false);
    }
  }

  return (
    <section className="account-feedback-panel">
      <div className="section-heading"><div><p className="eyebrow">Studyoo Account</p><h2>版本与反馈</h2></div><span className="version-badge">v{version?.version || "2.4.0"} · {version?.channel || "beta"}</span></div>
      <div className="feedback-layout">
        <form className="feedback-form" onSubmit={submit}>
          <label>反馈类型<select value={category} onChange={(event) => setCategory(event.target.value)}>{categories.map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
          <label>告诉我们发生了什么<textarea rows="5" value={message} onChange={(event) => setMessage(event.target.value)} placeholder="写下具体页面、操作和你期待的结果" /></label>
          <button className="primary" disabled={sending || message.trim().length < 5}>{sending ? "正在发送..." : "提交反馈"}</button>
        </form>
        <div className="feedback-history"><strong>我的反馈</strong>{items.length ? items.map((item) => <article key={item.id}><div><span>{categories.find(([value]) => value === item.category)?.[1] || "反馈"}</span><b className={`feedback-status ${item.status}`}>{statusLabels[item.status] || item.status}</b></div><p>{item.message}</p>{item.admin_note && <small>回复：{item.admin_note}</small>}<time>{new Date(item.created_at).toLocaleString("zh-CN")}</time></article>) : <p className="empty-copy">还没有提交过反馈。</p>}</div>
      </div>
    </section>
  );
}
