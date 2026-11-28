import type { ToolRoute } from '../navigation';

type IconName = ToolRoute['group'] | ToolRoute['section'];

const paths: Record<IconName, string> = {
  image: 'M3 4h18v16H3z M3 16l5-5 4 4 3-3 6 6 M15 8h.01',
  pdf: 'M5 3h9l5 5v13H5z M14 3v5h5 M8 16l3-5 2 6 3-3',
  video: 'M3 5h18v14H3z M10 9l5 3-5 3z',
  documents: 'M5 3h9l5 5v13H5z M14 3v5h5 M8 12h8 M8 16h8',
  all: 'M4 6l8-3 8 3-8 4z M4 11l8 4 8-4 M4 16l8 4 8-4',
  transform: 'M7 3v14h14 M3 7h14v14',
  compress: 'M4 4l5 5 M4 9h5V4 M20 20l-5-5 M15 20v-5h5',
  fill: 'M3 9V3h6 M15 3h6v6 M21 15v6h-6 M9 21H3v-6 M8 8h8v8H8z',
  color: 'M12 3c-3 4-6 7-6 11a6 6 0 0 0 12 0c0-4-3-7-6-11z M9 14a3 3 0 0 0 3 3',
  rotate: 'M4 9a8 8 0 1 1 1 9 M4 4v5h5',
  split: 'M3 5h6v14H3z M15 5h6v14h-6z M12 4v3m0 4v2m0 4v3',
  merge: 'M3 6h4l5 6h9 M3 18h4l5-6 M17 8l4 4-4 4',
  extractPages: 'M4 3h10v5 M4 3v18h10v-5 M9 12h12 M17 8l4 4-4 4',
  extractText: 'M4 6h16 M4 11h12 M4 16h16 M4 20h8',
  reorder: 'M4 5h12M4 12h12M4 19h12M20 4v16m-3-3 3 3 3-3',
  encrypt: 'M5 10h14v11H5z M8 10V7a4 4 0 0 1 8 0v3 M12 14v3',
  decrypt: 'M5 10h14v11H5z M8 10V7a4 4 0 0 1 8 0 M12 14v3',
  extractImages: 'M7 3h14v14h-4 M3 7h14v14H3z M3 17l4-4 3 3 2-2 5 5',
  render: 'M3 5h18v14H3z M3 15l5-5 4 4 3-3 6 6 M15 8h.01 M8 22h8',
  transcode: 'M3 7h15m-4-4 4 4-4 4 M21 17H6m4-4-4 4 4 4',
  docx2pdf: 'M5 3h10l4 4v6 M5 3v18h8 M8 8h6 M8 12h5 M14 17h7m-3-3 3 3-3 3',
  pdf2docx: 'M5 3h10l4 4v6 M5 3v18h8 M8 13l2-5 3 5 M21 17h-7m3-3-3 3 3 3',
};

export function ToolIcon({ name }: { name: IconName }) {
  return (
    <svg aria-hidden="true" focusable="false" viewBox="0 0 24 24" fill="none" stroke="currentColor"
      strokeWidth="1.65" strokeLinecap="round" strokeLinejoin="round">
      <path d={paths[name]} />
    </svg>
  );
}
