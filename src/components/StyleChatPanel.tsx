import React from "react";
import { MdImage } from "react-icons/md";
import { withTranslation, type WithTranslation } from "react-i18next";
import type { StyleSpecificationWithId } from "../libs/definitions";
import type { OnStyleChangedCallback } from "../libs/definitions";
import { editStyleWithLLM, type AttachedImage } from "../libs/style-chat";

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
  hadImage?: boolean;
};

type StyleChatPanelState = {
  messages: ChatMessage[];
  loading: boolean;
  input: string;
  attachedImage: AttachedImage | null;
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
      attachedImage: null,
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

    const attachedImage = this.state.attachedImage;
    const userMessage: ChatMessage = {
      role: "user",
      content: prompt,
      hadImage: !!attachedImage,
    };
    this.setState((s) => ({
      messages: [...s.messages, userMessage],
      input: "",
      attachedImage: null,
      loading: true,
    }));

    const history: ChatMessage[] = [...this.state.messages, userMessage];

    const result = await editStyleWithLLM({
      style: this.props.mapStyle,
      prompt,
      image: attachedImage ?? undefined,
      conversationHistory: history.slice(-6),
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
      this.setState((s) => ({
        messages: [...s.messages, { role: "assistant", content: assistantContent }],
        loading: false,
      }));
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
    const file = e.target.files?.[0];
    if (!file) return;
    const allowed = ["image/jpeg", "image/png", "image/gif", "image/webp"];
    if (!allowed.includes(file.type)) {
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      const dataUrl = reader.result as string;
      const match = dataUrl.match(/^data:(image\/[a-z]+);base64,(.+)$/);
      if (match) {
        this.setState({
          attachedImage: { dataBase64: match[2], mediaType: match[1] },
        });
      }
    };
    reader.readAsDataURL(file);
    e.target.value = "";
  };

  onClearImage = () => {
    this.setState({ attachedImage: null });
  };

  onAttachImageClick = () => {
    this.imageInputRef.current?.click();
  };

  render() {
    const t = this.props.t;
    const { messages, loading, input, attachedImage } = this.state;

    return (
      <div className="maputnik-style-chat-panel">
        <div className="maputnik-style-chat-panel__messages">
          {messages.length === 0 && (
            <p className="maputnik-style-chat-panel__placeholder">
              {linkify(
                t("Tell me how you'd like to style the map and I'll try my best to edit the style.json file to implement it. If you have any problems, submit an issue or fork it from the original: https://github.com/maplibre/maputnik or my fork: https://github.com/Willjfield/maputnik")
              )}
            </p>
          )}
          {messages.map((msg, i) => (
            <div
              key={i}
              className={`maputnik-style-chat-panel__message maputnik-style-chat-panel__message--${msg.role}`}
            >
              {msg.content}
              {msg.hadImage && (
                <span className="maputnik-style-chat-panel__image-badge">
                  {" "}({t("image attached")})
                </span>
              )}
            </div>
          ))}
          {loading && (
            <div className="maputnik-style-chat-panel__message maputnik-style-chat-panel__message--assistant">
              {t("Loading…")}
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
              {attachedImage && (
                <span className="maputnik-style-chat-panel__attached">
                  {t("Image attached")}
                  <button
                    type="button"
                    className="maputnik-style-chat-panel__clear-image"
                    onClick={this.onClearImage}
                    aria-label={t("Remove image")}
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
