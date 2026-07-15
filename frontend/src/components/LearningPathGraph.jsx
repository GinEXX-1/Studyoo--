import { useEffect, useMemo, useRef, useState } from "react";

const fallbackNodes = [
  { id: "foundation", name: "基础概念", status: "done", x: .12, y: .58 },
  { id: "method", name: "核心方法", status: "done", x: .34, y: .35 },
  { id: "current", name: "当前重点", status: "current", x: .56, y: .55 },
  { id: "apply", name: "综合应用", status: "next", x: .78, y: .32 },
  { id: "master", name: "迁移掌握", status: "locked", x: .9, y: .66 },
];

const connections = [[0, 1], [1, 2], [2, 3], [3, 4]];

export default function LearningPathGraph({ abilities = [], onStart }) {
  const canvasRef = useRef(null);
  const frameRef = useRef(null);
  const [selectedId, setSelectedId] = useState("current");

  const nodes = useMemo(() => fallbackNodes.map((node, index) => ({
    ...node,
    name: abilities[index]?.tag || node.name,
    score: abilities[index]?.average_score ?? (node.status === "done" ? 82 : node.status === "current" ? 56 : 0),
  })), [abilities]);

  const selected = nodes.find((node) => node.id === selectedId) || nodes[2];

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return undefined;
    const context = canvas.getContext("2d");
    let width = 0;
    let height = 0;
    let points = [];

    function resize() {
      const rect = canvas.getBoundingClientRect();
      const density = window.devicePixelRatio || 1;
      width = Math.max(280, rect.width);
      height = Math.max(260, rect.height);
      canvas.width = Math.round(width * density);
      canvas.height = Math.round(height * density);
      context.setTransform(density, 0, 0, density, 0, 0);
      const mobile = width < 520;
      points = nodes.map((node, index) => mobile
        ? { ...node, px: width * (.28 + (index % 2) * .44), py: 40 + index * ((height - 80) / 4), radius: node.status === "current" ? 25 : 21 }
        : { ...node, px: width * node.x, py: height * node.y, radius: node.status === "current" ? 27 : 23 });
    }

    function draw(time) {
      context.clearRect(0, 0, width, height);
      connections.forEach(([from, to]) => {
        const a = points[from];
        const b = points[to];
        context.beginPath();
        context.moveTo(a.px, a.py);
        context.lineTo(b.px, b.py);
        context.lineWidth = 2;
        context.strokeStyle = b.status === "locked" ? "rgba(26,25,21,.14)" : "rgba(46,196,143,.48)";
        context.setLineDash(b.status === "locked" ? [5, 6] : []);
        context.stroke();
      });
      context.setLineDash([]);

      points.forEach((node) => {
        if (node.status === "current") {
          context.beginPath();
          context.arc(node.px, node.py, node.radius + 7 + Math.sin(time / 420) * 4, 0, Math.PI * 2);
          context.fillStyle = "rgba(255,196,77,.22)";
          context.fill();
        }
        context.beginPath();
        context.arc(node.px, node.py, node.radius, 0, Math.PI * 2);
        context.fillStyle = node.status === "done" ? "#2ec48f" : node.status === "current" ? "#ffc44d" : node.status === "next" ? "#8b7cf6" : "#ede7d9";
        context.fill();
        if (node.status === "locked") {
          context.lineWidth = 1.5;
          context.strokeStyle = "#b3aea0";
          context.setLineDash([3, 3]);
          context.stroke();
          context.setLineDash([]);
        }
        if (node.id === selectedId) {
          context.beginPath();
          context.arc(node.px, node.py, node.radius + 5, 0, Math.PI * 2);
          context.lineWidth = 2;
          context.strokeStyle = "#1a1915";
          context.stroke();
        }
        context.fillStyle = node.status === "done" || node.status === "next" ? "#fff" : "#1a1915";
        context.font = "600 12px 'PingFang SC', sans-serif";
        context.textAlign = "center";
        context.textBaseline = "middle";
        context.fillText(node.status === "done" ? "✓" : String(Math.max(0, Math.round(node.score))), node.px, node.py);
        context.fillStyle = "#4a463c";
        context.font = `${node.id === selectedId ? "600" : "500"} 12px 'PingFang SC', sans-serif`;
        context.textBaseline = "top";
        context.fillText(node.name.slice(0, 8), node.px, node.py + node.radius + 8);
      });
      frameRef.current = requestAnimationFrame(draw);
    }

    function selectNode(event) {
      const rect = canvas.getBoundingClientRect();
      const x = event.clientX - rect.left;
      const y = event.clientY - rect.top;
      const hit = points.find((node) => Math.hypot(node.px - x, node.py - y) <= node.radius + 12);
      if (hit) setSelectedId(hit.id);
    }

    const observer = new ResizeObserver(resize);
    observer.observe(canvas);
    resize();
    frameRef.current = requestAnimationFrame(draw);
    canvas.addEventListener("click", selectNode);
    return () => {
      observer.disconnect();
      canvas.removeEventListener("click", selectNode);
      cancelAnimationFrame(frameRef.current);
    };
  }, [nodes, selectedId]);

  return (
    <div className="path-graph-block">
      <div className="path-graph-canvas-wrap">
        <canvas ref={canvasRef} className="path-graph-canvas" aria-label="个性化学习路径节点图" />
        <span>点击节点查看学习建议</span>
      </div>
      <div className="path-graph-detail">
        <div><strong>{selected.name}</strong><span>{selected.status === "done" ? "已掌握" : selected.status === "current" ? "进行中" : selected.status === "locked" ? "待解锁" : "即将学习"}</span><p>{selected.status === "done" ? "这一知识点已形成稳定记录，可以进入综合迁移。" : "根据最近作答与复测节奏，建议从这里继续推进。"}</p></div>
        <button className="primary" onClick={onStart}>开始学习</button>
      </div>
    </div>
  );
}
