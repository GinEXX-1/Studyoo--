import { Component } from "react";
import { toast } from "sonner";

export default class ErrorBoundary extends Component {
  constructor(props) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error) {
    return { hasError: true, error };
  }

  componentDidCatch(error, errorInfo) {
    console.error("Error Boundary caught error:", error, errorInfo);
    toast.error("页面加载出错，请刷新重试");
  }

  render() {
    if (this.state.hasError) {
      return (
        <main className="auth-shell">
          <div style={{ textAlign: "center" }}>
            <p className="eyebrow">Error</p>
            <h1>页面加载出错</h1>
            <p style={{ color: "#697069", marginTop: "16px" }}>{this.state.error?.message || "未知错误"}</p>
            <button 
              className="primary" 
              style={{ marginTop: "24px" }}
              onClick={() => {
                this.setState({ hasError: false, error: null });
                window.location.reload();
              }}
            >
              刷新页面
            </button>
          </div>
        </main>
      );
    }

    return this.props.children;
  }
}