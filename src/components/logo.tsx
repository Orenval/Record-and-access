import type { SVGProps } from "react";

export function Logo({
  size = 24,
  strokeWidth = 2,
  className,
  ...props
}: SVGProps<SVGSVGElement> & { size?: number; strokeWidth?: number }) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden="true"
      {...props}
    >
      {/* Left page */}
      <path d="M10.5 5C7.5 4 4.5 4 2 5.5v13C4.5 17 7.5 17 10.5 18" />
      {/* Right page */}
      <path d="M13.5 5C16.5 4 19.5 4 22 5.5v13C19.5 17 16.5 17 13.5 18" />
      {/* Bottom spine seam */}
      <path d="M10.5 18c.5.5 1 .75 1.5.75s1-.25 1.5-.75" />
      {/* Small ribbon bookmark hanging from top of pages */}
      <path d="M10.5 3h3v7.5l-1.5-1.2-1.5 1.2Z" />
      {/* Spine seam below ribbon */}
      <path d="M12 9.5v8.5" />
    </svg>
  );
}

