import React from "react";
import { withTranslation, type WithTranslation } from "react-i18next";
import Modal from "./Modal";
import StyleChatPanel from "../StyleChatPanel";
import type { StyleSpecificationWithId } from "../../libs/definitions";
import type { OnStyleChangedCallback } from "../../libs/definitions";

type ModalChatInternalProps = {
  isOpen: boolean;
  onOpenToggle(): void;
  mapStyle: StyleSpecificationWithId;
  onStyleChanged: OnStyleChangedCallback;
} & WithTranslation;

class ModalChatInternal extends React.Component<ModalChatInternalProps> {
  render() {
    const t = this.props.t;
    return (
      <Modal
        data-wd-key="modal:chat"
        isOpen={this.props.isOpen}
        onOpenToggle={this.props.onOpenToggle}
        title={t("Edit style with AI")}
        className="maputnik-modal-chat"
      >
        <StyleChatPanel
          mapStyle={this.props.mapStyle}
          onStyleChanged={this.props.onStyleChanged}
        />
      </Modal>
    );
  }
}

const ModalChat = withTranslation()(ModalChatInternal);
export default ModalChat;
