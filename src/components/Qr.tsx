"use client";

/** QR generado en el navegador (costo cero, sin servicios externos). */

import { useEffect, useState } from "react";

export function Qr({ value, size = 168 }: { value: string; size?: number }) {
  const [dataUrl, setDataUrl] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    void import("qrcode").then((QRCode) =>
      QRCode.toDataURL(value, {
        margin: 1,
        width: size * 2,
        color: { dark: "#0a0a0a", light: "#ffffff" },
      })
        .then((url) => alive && setDataUrl(url))
        .catch(() => alive && setDataUrl(null)),
    );
    return () => {
      alive = false;
    };
  }, [value, size]);

  if (!dataUrl) {
    return (
      <div
        className="grid place-items-center rounded-xl bg-white/10 text-xs text-white/60"
        style={{ width: size, height: size }}
      >
        Generando QR…
      </div>
    );
  }

  // eslint-disable-next-line @next/next/no-img-element
  return <img src={dataUrl} alt="Código QR para entrar a la fiesta" width={size} height={size} />;
}
