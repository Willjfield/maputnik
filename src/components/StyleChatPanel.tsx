import React from "react";
import { MdImage } from "react-icons/md";
import { withTranslation, type WithTranslation } from "react-i18next";
import type { StyleSpecificationWithId } from "../libs/definitions";
import type { OnStyleChangedCallback } from "../libs/definitions";
import { editStyleWithLLM, extractMapContext, type AttachedImage } from "../libs/style-chat";

/** Turn URLs in a string into clickable links; returns React nodes for use in JSX. */
function linkify(text: string): React.ReactNode {
  const urlRegex = /(https?:\/\/[^\s]+)/g;
  const parts = text.split(urlRegex);
  return parts.map((part, i) =>
    part.match(urlRegex) ? (
      <a key={i} href={part} target="_blank" rel="noopener noreferrer">
        {part}
      </a>
    ) : (
      part
    )
  );
}

type StyleChatPanelInternalProps = {
  mapStyle: StyleSpecificationWithId;
  onStyleChanged: OnStyleChangedCallback;
} & WithTranslation;

type ChatMessage = {
  role: "user" | "assistant";
  content: string;
  imageCount?: number;
};

type StyleChatPanelState = {
  messages: ChatMessage[];
  loading: boolean;
  input: string;
  attachedImages: AttachedImage[];
  mapContext: string | null;
};

class StyleChatPanelInternal extends React.Component<StyleChatPanelInternalProps, StyleChatPanelState> {
  private messagesEndRef = React.createRef<HTMLDivElement>();
  private imageInputRef = React.createRef<HTMLInputElement>();

  constructor(props: StyleChatPanelInternalProps) {
    super(props);
    this.state = {
      messages: [],
      loading: false,
      input: "",
      attachedImages: [],
      mapContext: null,
    };
  }

  componentDidUpdate(_prevProps: StyleChatPanelInternalProps, prevState: StyleChatPanelState) {
    if (this.state.messages.length !== prevState.messages.length) {
      this.messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
    }
  }

  onSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const prompt = this.state.input.trim();
    if (!prompt || this.state.loading) return;

    const attachedImages = this.state.attachedImages;
    const userMessage: ChatMessage = {
      role: "user",
      content: prompt,
      imageCount: attachedImages.length || undefined,
    };
    this.setState((s) => ({
      messages: [...s.messages, userMessage],
      input: "",
      attachedImages: [],
      loading: true,
    }));

    const history: ChatMessage[] = [...this.state.messages, userMessage];

    const result = await editStyleWithLLM({
      style: this.props.mapStyle,
      prompt,
      images: attachedImages.length ? attachedImages : undefined,
      conversationHistory: history.slice(-6),
      mapContext: this.state.mapContext ?? undefined,
    });

    if (result.ok) {
      const styleWithId: StyleSpecificationWithId = {
        ...result.style,
        id: result.style.id || this.props.mapStyle.id,
      };
      this.props.onStyleChanged(styleWithId, { addRevision: true, save: true });
      const assistantContent = result.explanation
        ? `${this.props.t("Style updated.")} ${result.explanation}`
        : this.props.t("Style updated.");
      const newMessages: ChatMessage[] = [...this.state.messages, userMessage, { role: "assistant", content: assistantContent }];
      const userMessageCount = newMessages.filter((m) => m.role === "user").length;
      this.setState((s) => ({
        messages: [...s.messages, { role: "assistant", content: assistantContent }],
        loading: false,
      }));
      if (userMessageCount >= 1 && userMessageCount <= 3) {
        const fullHistory = [...history, { role: "assistant" as const, content: assistantContent }];
        extractMapContext({
          conversationHistory: fullHistory.map((m) => ({ role: m.role, content: m.content })),
        }).then((extracted) => {
          if (extracted?.trim()) {
            this.setState((s) => ({ mapContext: s.mapContext || extracted }));
          }
        });
      }
    } else {
      this.setState((s) => ({
        messages: [...s.messages, { role: "assistant", content: result.error }],
        loading: false,
      }));
    }
  };

  onInputChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    this.setState({ input: e.target.value });
  };

  onTextareaKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key !== "Enter") return;
    if (e.ctrlKey || e.metaKey) {
      return;
    }
    e.preventDefault();
    if (this.state.input.trim() && !this.state.loading) {
      this.onSubmit(e as unknown as React.FormEvent);
    }
  };

  onImageSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files ?? []);
    if (files.length === 0) return;

    const allowed = ["image/jpeg", "image/png", "image/gif", "image/webp"];
    const MAX_REFERENCE_IMAGES = 5;

    const toRead = files
      .filter((f) => allowed.includes(f.type))
      .slice(0, Math.max(0, MAX_REFERENCE_IMAGES - this.state.attachedImages.length));

    const readFileAsAttachedImage = (file: File): Promise<AttachedImage | null> =>
      new Promise((resolve) => {
        const reader = new FileReader();
        reader.onload = () => {
          const dataUrl = reader.result as string;
          const match = dataUrl.match(/^data:(image\/[a-z]+);base64,(.+)$/);
          if (!match) return resolve(null);
          resolve({ dataBase64: match[2], mediaType: match[1] });
        };
        reader.onerror = () => resolve(null);
        reader.readAsDataURL(file);
      });

    Promise.all(toRead.map(readFileAsAttachedImage)).then((images) => {
      const cleaned = images.filter((x): x is AttachedImage => !!x);
      if (cleaned.length === 0) return;
      this.setState((s) => ({ attachedImages: [...s.attachedImages, ...cleaned] }));
    });

    e.target.value = "";
  };

  onClearImages = () => {
    this.setState({ attachedImages: [] });
  };

  onAttachImageClick = () => {
    this.imageInputRef.current?.click();
  };

  render() {
    const t = this.props.t;
    const { messages, loading, input, attachedImages } = this.state;

    return (
      <div className="maputnik-style-chat-panel">
        <div className="maputnik-style-chat-panel__messages">
          {messages.length === 0 && (
            <div className="maputnik-style-chat-panel__placeholder">
              <p>
                {linkify(
                  t("Tell me how you'd like to style the map and I'll try my best to edit the style.json file to implement it. If you have any problems, submit an issue or fork it from the original: https://github.com/maplibre/maputnik or my fork: https://github.com/Willjfield/maputnik")
                )}
              </p>
              <p className="maputnik-style-chat-panel__placeholder-tip">
                {t("Optional: describing what this map is for and who will use it helps me suggest more tailored and accessible styles.")}
              </p>
            </div>
          )}
          {messages.map((msg, i) => (
            <div
              key={i}
              className={`maputnik-style-chat-panel__message maputnik-style-chat-panel__message--${msg.role}`}
            >
              {msg.content}
              {msg.imageCount ? (
                <span className="maputnik-style-chat-panel__image-badge">
                  {" "}
                  {msg.imageCount === 1 ? t("image attached") : t("images attached")}
                  {msg.imageCount > 1 ? `: ${msg.imageCount}` : ""}
                </span>
              ) : null}
            </div>
          ))}
          {loading && (
            <div className="maputnik-style-chat-panel__message maputnik-style-chat-panel__message--assistant maputnik-style-chat-panel__thinking">
              <span className="maputnik-style-chat-panel__thinking-spinner" aria-hidden="true" />
              <span className="maputnik-style-chat-panel__thinking-text">
                {t("Thinking")}
                <span className="maputnik-style-chat-panel__thinking-dots" aria-hidden="true">
                  <span>.</span><span>.</span><span>.</span>
                </span>
              </span>
            </div>
          )}
          <div ref={this.messagesEndRef} />
        </div>
        <form className="maputnik-style-chat-panel__form" onSubmit={this.onSubmit}>
          <textarea
            className="maputnik-style-chat-panel__input"
            value={input}
            onChange={this.onInputChange}
            onKeyDown={this.onTextareaKeyDown}
            placeholder={t("Enter your request…")}
            rows={2}
            disabled={loading}
            aria-label={t("Enter your request…")}
          />
          <div className="maputnik-style-chat-panel__form-row">
            <div className="maputnik-style-chat-panel__form-left">
              <input
                ref={this.imageInputRef}
                className="maputnik-style-chat-panel__attach-input"
                type="file"
                multiple
                accept="image/jpeg,image/png,image/gif,image/webp"
                onChange={this.onImageSelect}
                disabled={loading}
                aria-label={t("Attach map image")}
              />
              <button
                type="button"
                className="maputnik-style-chat-panel__attach-button"
                onClick={this.onAttachImageClick}
                disabled={loading}
                title={t("Attach map image")}
                aria-label={t("Attach map image")}
              >
                <MdImage className="maputnik-style-chat-panel__attach-icon" />
              </button>
              {attachedImages.length > 0 && (
                <span className="maputnik-style-chat-panel__attached">
                  {t("Images attached")}: {attachedImages.length}
                  <button
                    type="button"
                    className="maputnik-style-chat-panel__clear-image"
                    onClick={this.onClearImages}
                    aria-label={t("Remove images")}
                  >
                    ×
                  </button>
                </span>
              )}
              <span className="maputnik-style-chat-panel__hint" aria-hidden="true">
                {t("Enter to send · Ctrl+Enter for new line")}
              </span>
            </div>
            <button
              type="submit"
              className="maputnik-button maputnik-style-chat-panel__submit"
              disabled={loading || !input.trim()}
            >
              {t("Send")}
            </button>
          </div>
        </form>
      </div>
    );
  }
}

const StyleChatPanel = withTranslation()(StyleChatPanelInternal);
export default StyleChatPanel;
