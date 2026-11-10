import React from "react";

interface ReadoraLogoProps {
  /** Pixel size of the rendered SVG mark. Sizes <= 36 use the 26A simplified vector; > 36 use the 26 master vector. */
  size?: number;
  className?: string;
}

/**
 * Official Readora App Logo & Mark from Figma:
 * - Frame `26 · App Icon / 1024 Master` (`16:2` / `16:3`) for larger display (`size > 36`)
 * - Frame `26A · App Icon / 32px Simplified` (`16:7` / `16:8`) for compact UI surfaces (`size <= 36`)
 */
export const ReadoraLogo: React.FC<ReadoraLogoProps> = ({
  size = 24,
  className = "",
}) => {
  if (size <= 36) {
    return (
      <svg
        width={size}
        height={size}
        viewBox="0 0 32 32"
        fill="none"
        xmlns="http://www.w3.org/2000/svg"
        className={`readora-logo-svg ${className}`.trim()}
        aria-hidden="true"
        data-node-id="16:8"
      >
        <path d="M3.5 5.5L14.5625 11V26.75L3.5 20.75V5.5Z" fill="#2F6B5D" />
        <path d="M28.5 5.5L17.4375 11V26.75L28.5 20.75V5.5Z" fill="#A7BE7E" />
        <path
          d="M15 11.75H17V21.75L16 20.9375L15 21.75V11.75Z"
          fill="#E4765B"
        />
      </svg>
    );
  }

  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 1024 1024"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      className={`readora-logo-svg ${className}`.trim()}
      aria-hidden="true"
      data-node-id="16:3"
    >
      <path
        d="M112 180C112 153 141 136 165 149L435 294C462 309 478 337 478 368V856L132 674C125.874 670.706 120.769 665.794 117.243 659.798C113.716 653.803 111.903 646.955 112 640V180Z"
        fill="#2F6B5D"
      />
      <path
        d="M912 180C912 153 883 136 859 149L589 294C562 309 546 337 546 368V856L892 674C898.126 670.706 903.231 665.794 906.757 659.798C910.284 653.803 912.097 646.955 912 640V180Z"
        fill="#A7BE7E"
      />
      <path d="M488 392H536V686L512 666L488 686V392Z" fill="#E4765B" />
    </svg>
  );
};
