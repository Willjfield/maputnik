import React from "react";
import { MdClose } from "react-icons/md";
import { withTranslation, type WithTranslation } from "react-i18next";
import StyleChatPanel from "../StyleChatPanel";
import type { StyleSpecificationWithId } from "../../libs/definitions";
import type { OnStyleChangedCallback } from "../../libs/definitions";

const DEFAULT_X = 80;
const DEFAULT_Y = 24;

type ModalChatInternalProps = {
  isOpen: boolean;
  onOpenToggle(): void;
  mapStyle: StyleSpecificationWithId;
  onStyleChanged: OnStyleChangedCallback;
} & WithTranslation;

type ModalChatState = {
  x: number;
  y: number;
  dragStart: { x: number; y: number; left: number; top: number } | null;
};

class ModalChatInternal extends React.Component<ModalChatInternalProps, ModalChatState> {
  private containerRef = React.createRef<HTMLDivElement>();

  constructor(props: ModalChatInternalProps) {
    super(props);
    this.state = { x: DEFAULT_X, y: DEFAULT_Y, dragStart: null };
  }

  onClose = () => {
    if (document.activeElement) {
      (document.activeElement as HTMLElement).blur();
    }
    this.props.onOpenToggle();
  };

  onTitleMouseDown = (e: React.MouseEvent) => {
    if ((e.target as HTMLElement).closest("button")) return;
    this.setState({
      dragStart: {
        x: e.clientX,
        y: e.clientY,
        left: this.state.x,
        top: this.state.y,
      },
    });
  };

  componentDidUpdate(_prevProps: ModalChatInternalProps, prevState: ModalChatState) {
    const { dragStart } = this.state;
    if (dragStart && !prevState.dragStart) {
      window.addEventListener("mousemove", this.onDragMove);
      window.addEventListener("mouseup", this.onDragEnd);
    } else if (!dragStart && prevState.dragStart) {
      window.removeEventListener("mousemove", this.onDragMove);
      window.removeEventListener("mouseup", this.onDragEnd);
    }
  }

  componentWillUnmount() {
    window.removeEventListener("mousemove", this.onDragMove);
    window.removeEventListener("mouseup", this.onDragEnd);
  }

  onDragMove = (e: MouseEvent) => {
    const { dragStart } = this.state;
    if (!dragStart) return;
    this.setState({
      x: dragStart.left + (e.clientX - dragStart.x),
      y: dragStart.top + (e.clientY - dragStart.y),
    });
  };

  onDragEnd = () => {
    this.setState({ dragStart: null });
  };

  render() {
    const t = this.props.t;
    if (!this.props.isOpen) return null;

    return (
      <div
        ref={this.containerRef}
        className="maputnik-chat-float"
        data-wd-key="modal:chat"
        role="dialog"
        aria-label={t("Edit style with AI")}
        style={{ left: this.state.x, top: this.state.y }}
      >
        <div className="maputnik-modal maputnik-modal-chat">
          <header
            className="maputnik-modal-header maputnik-chat-float__titlebar"
            onMouseDown={this.onTitleMouseDown}
          >
            <h1 className="maputnik-modal-header-title">{t("Edit style with AI")}</h1>
            <span className="maputnik-space" />
            <button
              type="button"
              className="maputnik-modal-header-toggle"
              title={t("Close modal")}
              onClick={this.onClose}
              data-wd-key="modal:chat.close-modal"
            >
              <MdClose />
            </button>
          </header>
          <div className="maputnik-modal-scroller">
            <div className="maputnik-modal-content">
              <StyleChatPanel
                mapStyle={this.props.mapStyle}
                onStyleChanged={this.props.onStyleChanged}
              />
            </div>
          </div>
        </div>
      </div>
    );
  }
}

const ModalChat = withTranslation()(ModalChatInternal);
export default ModalChat;
