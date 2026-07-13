export default function MountainMark({ dark = false }) {
  return (
    <svg className={`mountain-mark${dark ? " mountain-mark-dark" : ""}`} viewBox="0 0 900 180" preserveAspectRatio="xMidYMax meet" aria-hidden="true">
      <path d="M0 170C90 112 128 132 190 96c52-31 92-49 147-8 45 34 66 30 111-10 45-40 82-41 130-3 51 40 85 31 130-3 52-39 101-35 192 28v80H0Z" fill="currentColor" opacity=".28" />
      <path d="M0 180c88-38 133-75 193-53 63 22 84 14 144-36 52-43 97-28 145 10 47 37 80 37 130-8 46-41 95-43 161 4 38 27 72 30 127 16v67H0Z" fill="currentColor" opacity=".5" />
    </svg>
  );
}
