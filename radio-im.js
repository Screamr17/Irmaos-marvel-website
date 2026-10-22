
(() => {
  "use strict";

  if (document.getElementById("im-radio-toggle")) return;

  const PLAYLIST_ID = "6eJDE2k8UWlM4oqgjDrzeE";

  const style = document.createElement("style");
  style.textContent = `
    .im-radio-toggle {
      position: fixed;
      right: 17px;
      bottom: 154px;
      z-index: 42;
      width: 54px;
      height: 54px;
      border: 1px solid #eac27b;
      border-radius: 50%;
      background: linear-gradient(145deg,#bd8a38,#67451a);
      color: white;
      font-size: 25px;
      cursor: pointer;
      box-shadow: 0 5px 22px #0009;
      display: grid;
      place-items: center;
    }

    .im-radio-window {
      display: none;
      position: fixed;
      right: 17px;
      bottom: 218px;
      z-index: 43;
      width: min(370px, calc(100vw - 24px));
      max-height: calc(100dvh - 235px);
      overflow: auto;
      background: #071426;
      border: 1px solid #c69a53;
      border-radius: 17px;
      box-shadow: 0 15px 45px #000c;
      color: #fff;
    }

    .im-radio-window.open {
      display: block;
    }

    .im-radio-head {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 10px;
      padding: 14px;
      background: linear-gradient(120deg,#173c6c,#08192f);
      border-bottom: 1px solid #456080;
    }

    .im-radio-head strong {
      color: #ffc66a;
      font-size: 15px;
    }

    .im-radio-head small {
      display: block;
      color: #bcd4ed;
      margin-top: 4px;
      font-size: 11px;
    }

    .im-radio-close {
      background: #203d61;
      border: 1px solid #6685a9;
      color: white;
      border-radius: 8px;
      padding: 7px 11px;
      cursor: pointer;
    }

    .im-radio-body {
      padding: 12px;
    }

    .im-radio-frame {
      width: 100%;
      height: 352px;
      border: 0;
      border-radius: 12px;
      background: #14243a;
      display: block;
    }

    .im-radio-note {
      text-align: center;
      color: #bcd4ed;
      font-size: 11px;
      line-height: 1.5;
      margin: 12px 0 0;
    }

    .im-radio-toggle:focus-visible,
    .im-radio-close:focus-visible {
      outline: 3px solid #ffc66a;
      outline-offset: 3px;
    }

    @media (max-width: 700px) {
      .im-radio-toggle {
        bottom: calc(224px + env(safe-area-inset-bottom));
      }

      .im-radio-window {
        right: 12px;
        bottom: calc(290px + env(safe-area-inset-bottom));
        max-height: calc(100dvh - 310px - env(safe-area-inset-bottom));
      }

      .im-radio-frame {
        height: 300px;
      }
    }

    @media (max-height: 620px) {
      .im-radio-window {
        bottom: 12px;
        max-height: calc(100dvh - 24px);
      }
    }
  `;
  document.head.appendChild(style);

  const toggle = document.createElement("button");
  toggle.id = "im-radio-toggle";
  toggle.className = "im-radio-toggle";
  toggle.type = "button";
  toggle.textContent = "🎵";
  toggle.setAttribute("aria-label", "Abrir Rádio IM");
  toggle.setAttribute("aria-expanded", "false");
  toggle.setAttribute("aria-controls", "im-radio-window");

  const panel = document.createElement("section");
  panel.id = "im-radio-window";
  panel.className = "im-radio-window";
  panel.setAttribute("aria-label", "Rádio IRMÃOS MARVEL");
  panel.setAttribute("aria-hidden", "true");

  const header = document.createElement("div");
  header.className = "im-radio-head";

  const title = document.createElement("div");
  const strong = document.createElement("strong");
  strong.textContent = "🎵 RÁDIO IRMÃOS MARVEL";

  const subtitle = document.createElement("small");
  subtitle.textContent = "Playlist oficial • Spotify";

  title.append(strong, subtitle);

  const close = document.createElement("button");
  close.type = "button";
  close.className = "im-radio-close";
  close.textContent = "✕";
  close.setAttribute("aria-label", "Fechar rádio");

  header.append(title, close);

  const body = document.createElement("div");
  body.className = "im-radio-body";

  const frame = document.createElement("iframe");
  frame.className = "im-radio-frame";
  frame.title = "Playlist Spotify — Rádio IM";
  frame.setAttribute("allow", "autoplay; clipboard-write; encrypted-media; fullscreen; picture-in-picture");
  frame.setAttribute("loading", "lazy");
  frame.setAttribute("referrerpolicy", "strict-origin-when-cross-origin");

  const note = document.createElement("p");
  note.className = "im-radio-note";
  note.textContent = "Carrega em Play no Spotify para ouvir. Algumas músicas podem exigir a aplicação Spotify.";

  body.append(frame, note);
  panel.append(header, body);
  document.body.append(toggle, panel);

  let loaded = false;

  function setOpen(open) {
    if (open && !loaded) {
      frame.src =
        "https://open.spotify.com/embed/playlist/" +
        PLAYLIST_ID +
        "?utm_source=generator";
      loaded = true;
    }

    panel.classList.toggle("open", open);
    panel.setAttribute("aria-hidden", String(!open));
    toggle.setAttribute("aria-expanded", String(open));
    toggle.setAttribute(
      "aria-label",
      open ? "Fechar Rádio IM" : "Abrir Rádio IM"
    );
  }

  toggle.addEventListener("click", () => {
    setOpen(!panel.classList.contains("open"));
  });

  close.addEventListener("click", () => {
    setOpen(false);
    toggle.focus();
  });

  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && panel.classList.contains("open")) {
      setOpen(false);
      toggle.focus();
    }
  });
})();
