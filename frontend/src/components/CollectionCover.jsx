export default function CollectionCover({ collection, size = "regular" }) {
  return (
    <div className={`collection-cover cover-${collection.cover_style || "mint"} cover-${size}`}>
      <span>{collection.subject}</span>
      <strong>{collection.title}</strong>
      <small>{collection.question_count} 题</small>
    </div>
  );
}