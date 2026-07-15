import TiltedCard from "./TiltedCard.jsx";

const motifs = ["circle", "triangle", "diamond", "ring", "semi", "plus", "quarter", "stripes", "dots", "bars"];

export default function CollectionCover({ collection, size = "regular", variant = 0 }) {
  const motif = motifs[variant % motifs.length];

  return (
    <div className={`collection-cover-frame cover-${size}`}>
      <TiltedCard
        ariaLabel={`${collection.title}题库封面`}
        captionText={collection.title}
        rotateAmplitude={size === "large" ? 5 : 9}
        scaleOnHover={size === "large" ? 1.015 : 1.045}
        showTooltip={size !== "large"}
        displayOverlayContent
        overlayContent={
          <div className={`collection-cover cover-${collection.cover_style || "mint"} motif-${motif}`} aria-hidden="true">
            <i className={`cover-shape shape-${motif}`} />
            <i className="cover-orbit orbit-a" />
            <i className="cover-orbit orbit-b" />
          </div>
        }
      />
    </div>
  );
}
