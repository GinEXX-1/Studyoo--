import { useEffect, useMemo, useRef, useState } from "react";

const statusLabels = { mastered: "已掌握", active: "当前重点", ready: "可以开始", locked: "等待前置" };
const statusColors = { mastered: "#2ec48f", active: "#ffc44d", ready: "#8b7cf6", locked: "#ede7d9" };

function fallbackGraph() {
  return {
    focus_node_id: "fallback:current",
    nodes: [
      { id: "fallback:foundation", tag: "基础概念", status: "mastered", score: 82, reason: "完成几道题后，这里会换成你的真实知识点。", prerequisites: [] },
      { id: "fallback:current", tag: "当前重点", status: "active", score: 0, reason: "从一次真实作答开始建立你的能力图。", prerequisites: ["基础概念"] },
      { id: "fallback:apply", tag: "综合应用", status: "locked", score: 0, reason: "完成前置节点后解锁。", prerequisites: ["当前重点"] }
    ],
    edges: [
      { source: "fallback:foundation", target: "fallback:current" },
      { source: "fallback:current", target: "fallback:apply" }
    ]
  };
}

function layoutGraph(nodes, edges) {
  const incoming = new Map(nodes.map((node) => [node.id, []]));
  for (const edge of edges) incoming.get(edge.target)?.push(edge.source);
  const levels = new Map();
  function level(id, visiting = new Set()) {
    if (levels.has(id)) return levels.get(id);
    if (visiting.has(id)) return 0;
    visiting.add(id);
    const parents = incoming.get(id) || [];
    const value = parents.length ? Math.max(...parents.map((parent) => level(parent, visiting))) + 1 : 0;
    levels.set(id, value);
    visiting.delete(id);
    return value;
  }
  nodes.forEach((node) => level(node.id));
  const groups = new Map();
  nodes.forEach((node) => {
    const nodeLevel = levels.get(node.id) || 0;
    if (!groups.has(nodeLevel)) groups.set(nodeLevel, []);
    groups.get(nodeLevel).push(node);
  });
  const maxLevel = Math.max(1, ...groups.keys());
  return nodes.map((node) => {
    const nodeLevel = levels.get(node.id) || 0;
    const peers = groups.get(nodeLevel) || [node];
    const peerIndex = peers.findIndex((item) => item.id === node.id);
    return {
      ...node,
      x: .1 + nodeLevel / maxLevel * .8,
      y: peers.length === 1 ? .5 : .18 + peerIndex / (peers.length - 1) * .64
    };
  });
}

export default function LearningPathGraph({ graph, onStart }) {
  const canvasRef = useRef(null);
  const frameRef = useRef(null);
  const model = graph?.nodes?.length ? graph : fallbackGraph();
  const nodes = useMemo(() => layoutGraph(model.nodes, model.edges || []), [model]);
  const [selectedId, setSelectedId] = useState(model.focus_node_id || nodes[0]?.id);
  const selected = nodes.find((node) => node.id === selectedId) || nodes[0];

  useEffect(() => {
    setSelectedId(model.focus_node_id || nodes[0]?.id);
  }, [model.focus_node_id, model.subject]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !nodes.length) return undefined;
    const context = canvas.getContext("2d");
    let width = 0;
    let height = 0;
    let points = [];

    function resize() {
      const rect = canvas.getBoundingClientRect();
      const density = window.devicePixelRatio || 1;
      width = Math.max(280, rect.width);
      height = Math.max(300, rect.height);
      canvas.width = Math.round(width * density);
      canvas.height = Math.round(height * density);
      context.setTransform(density, 0, 0, density, 0, 0);
      const mobile = width < 520;
      points = nodes.map((node, index) => mobile
        ? { ...node, px: width * (.26 + (index % 2) * .48), py: 42 + index * Math.max(58, (height - 128) / Math.max(1, nodes.length - 1)), radius: node.status === "active" ? 25 : 21 }
        : { ...node, px: width * node.x, py: height * node.y, radius: node.status === "active" ? 27 : 22 });
    }

    function draw(time) {
      context.clearRect(0, 0, width, height);
      const byId = new Map(points.map((point) => [point.id, point]));
      for (const edge of model.edges || []) {
        const start = byId.get(edge.source);
        const end = byId.get(edge.target);
        if (!start || !end) continue;
        context.beginPath();
        context.moveTo(start.px, start.py);
        context.lineTo(end.px, end.py);
        context.lineWidth = 1.6;
        context.strokeStyle = end.status === "locked" ? "rgba(26,25,21,.14)" : "rgba(46,196,143,.5)";
        context.setLineDash(end.status === "locked" ? [5, 6] : []);
        context.stroke();
      }
      context.setLineDash([]);
      for (const node of points) {
        if (node.status === "active") {
          context.beginPath();
          context.arc(node.px, node.py, node.radius + 7 + Math.sin(time / 420) * 3, 0, Math.PI * 2);
          context.fillStyle = "rgba(255,196,77,.22)";
          context.fill();
        }
        context.beginPath();
        context.arc(node.px, node.py, node.radius, 0, Math.PI * 2);
        context.fillStyle = statusColors[node.status] || statusColors.ready;
        context.fill();
        if (node.id === selectedId) {
          context.beginPath();
          context.arc(node.px, node.py, node.radius + 5, 0, Math.PI * 2);
          context.lineWidth = 2;
          context.strokeStyle = "#1a1915";
          context.stroke();
        }
        context.fillStyle = ["mastered", "ready"].includes(node.status) ? "#fff" : "#1a1915";
        context.font = "600 11px 'PingFang SC', sans-serif";
        context.textAlign = "center";
        context.textBaseline = "middle";
        context.fillText(node.status === "mastered" ? "✓" : String(Math.round(node.score || 0)), node.px, node.py);
        context.fillStyle = "#4a463c";
        context.font = `${node.id === selectedId ? "600" : "500"} 11px 'PingFang SC', sans-serif`;
        context.textBaseline = "top";
        context.fillText(node.tag.slice(0, 8), node.px, node.py + node.radius + 7);
      }
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
  }, [nodes, model.edges, selectedId]);

  if (!selected) return null;
  return (
    <div className="path-graph-block">
      <div className="path-graph-canvas-wrap" style={{ "--graph-mobile-height": `${Math.max(380, nodes.length * 72 + 40)}px` }}>
        <canvas ref={canvasRef} className="path-graph-canvas" aria-label="有关联关系的个性化学习路径图" />
        <span>实线表示已具备的前置关系，虚线表示仍待解锁</span>
      </div>
      <div className="path-graph-detail">
        <div><strong>{selected.tag}</strong><span>{statusLabels[selected.status] || selected.status} · {selected.score || 0} 分</span><p>{selected.reason}</p>{selected.prerequisites?.length > 0 && <small>前置：{selected.prerequisites.join(" → ")}</small>}{selected.recommended_question_title && <small>推荐：{selected.recommended_question_title}</small>}</div>
        <button className="primary" disabled={selected.status === "locked"} onClick={() => onStart(selected)}>{selected.status === "locked" ? "完成前置后解锁" : "开始学习"}</button>
      </div>
    </div>
  );
}
