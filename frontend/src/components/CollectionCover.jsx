export default function CollectionCover({ collection, size = "regular" }) {
  const subjectShape = {
    语文: "circle",
    数学: "triangle",
    英语: "diamond",
    物理: "ring",
    化学: "semi",
    生物: "plus",
    历史: "quarter",
    政治: "stripes",
    地理: "dots",
  }[collection.subject] || "circle";

  return (
    <div className={`collection-cover cover-${collection.cover_style || "mint"} cover-${size}`}>
      <div className="collection-cover-top"><span>{collection.subject}</span><i className={`cover-shape shape-${subjectShape}`} aria-hidden="true" /></div>
      <strong>{collection.title}</strong>
      <small>{collection.question_count} 题</small>
    </div>
  );
}
