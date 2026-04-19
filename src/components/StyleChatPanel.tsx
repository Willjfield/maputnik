import React from "react";
import hash from "string-hash";
import { withTranslation, type WithTranslation } from "react-i18next";
import type { StyleSpecificationWithId } from "../libs/definitions";
import type { OnStyleChangedCallback } from "../libs/definitions";
import {
  applySelectedAccessibilityChanges,
  evaluateStyleAccessibility,
  suggestAccessibilityStyleChanges,
  type AccessibilityReport,
  type AccessibilitySuggestion,
} from "../libs/style-chat";

type StyleChatPanelInternalProps = {
  mapStyle: StyleSpecificationWithId;
  onStyleChanged: OnStyleChangedCallback;
} & WithTranslation;

type StyleChatPanelState = {
  report: AccessibilityReport | null;
  suggestions: AccessibilitySuggestion[];
  selectedSuggestionIds: string[];
  loading: boolean;
  loadingSuggestions: boolean;
  applyingChanges: boolean;
  error: string | null;
  success: string | null;
};

class StyleChatPanelInternal extends React.Component<StyleChatPanelInternalProps, StyleChatPanelState> {
  private reportCache = new Map<number, AccessibilityReport>();
  private suggestionsCache = new Map<number, AccessibilitySuggestion[]>();

  constructor(props: StyleChatPanelInternalProps) {
    super(props);
    this.state = {
      report: null,
      suggestions: [],
      selectedSuggestionIds: [],
      loading: false,
      loadingSuggestions: false,
      applyingChanges: false,
      error: null,
      success: null,
    };
  }

  getStyleHash = (): number => hash(JSON.stringify(this.props.mapStyle));

  onEvaluate = async () => {
    if (this.state.loading) return;
    const styleHash = this.getStyleHash();
    const cachedReport = this.reportCache.get(styleHash);
    if (cachedReport) {
      this.setState({
        report: cachedReport,
        suggestions: this.suggestionsCache.get(styleHash) ?? [],
        selectedSuggestionIds: (this.suggestionsCache.get(styleHash) ?? []).map((s) => s.id),
        loading: false,
        error: null,
        success: null,
      });
      return;
    }
    this.setState({ loading: true, error: null, success: null });
    const report = await evaluateStyleAccessibility({ style: this.props.mapStyle });
    if (!report) {
      this.setState({
        loading: false,
        error: this.props.t("Could not evaluate accessibility. Please try again."),
      });
      return;
    }
    this.reportCache.set(styleHash, report);
    this.setState({
      report,
      suggestions: [],
      selectedSuggestionIds: [],
      loading: false,
      error: null,
    });
  };

  onSuggestChanges = async () => {
    const { report, loadingSuggestions } = this.state;
    if (!report || loadingSuggestions) return;
    const styleHash = this.getStyleHash();
    const cachedSuggestions = this.suggestionsCache.get(styleHash);
    if (cachedSuggestions) {
      this.setState({
        suggestions: cachedSuggestions,
        selectedSuggestionIds: cachedSuggestions.map((s) => s.id),
        loadingSuggestions: false,
        error: null,
        success: null,
      });
      return;
    }
    this.setState({ loadingSuggestions: true, error: null, success: null });
    const result = await suggestAccessibilityStyleChanges({
      style: this.props.mapStyle,
      report,
    });
    if (!result) {
      this.setState({
        loadingSuggestions: false,
        error: this.props.t("Could not generate suggestions. Please try again."),
      });
      return;
    }
    this.suggestionsCache.set(styleHash, result.suggestions);
    this.setState({
      suggestions: result.suggestions,
      selectedSuggestionIds: result.suggestions.map((s) => s.id),
      loadingSuggestions: false,
      error: null,
    });
  };

  onToggleSuggestion = (suggestionId: string) => {
    this.setState((s) => {
      const exists = s.selectedSuggestionIds.includes(suggestionId);
      return {
        selectedSuggestionIds: exists
          ? s.selectedSuggestionIds.filter((id) => id !== suggestionId)
          : [...s.selectedSuggestionIds, suggestionId],
      };
    });
  };

  onApplySelectedChanges = () => {
    if (this.state.applyingChanges) return;
    this.setState({ applyingChanges: true, error: null, success: null }, () => {
      const result = applySelectedAccessibilityChanges({
        style: this.props.mapStyle,
        suggestions: this.state.suggestions,
        selectedSuggestionIds: this.state.selectedSuggestionIds,
      });
      if (!result.ok) {
        this.setState({
          applyingChanges: false,
          error: result.error,
        });
        return;
      }
      const styleWithId: StyleSpecificationWithId = {
        ...result.style,
        id: result.style.id || this.props.mapStyle.id,
      };
      this.props.onStyleChanged(styleWithId, { addRevision: true, save: true });
      this.setState({
        applyingChanges: false,
        success: result.explanation || this.props.t("Applied selected accessibility changes."),
      });
    });
  };

  render() {
    const t = this.props.t;
    const {
      report,
      loading,
      loadingSuggestions,
      applyingChanges,
      suggestions,
      selectedSuggestionIds,
      error,
      success,
    } = this.state;
    const hasSuggestions = suggestions.length > 0;
    const canApply = selectedSuggestionIds.length > 0 && !applyingChanges;
    const loadingMessage = loading
      ? t("Evaluating style for accessibility...")
      : loadingSuggestions
        ? t("Generating accessibility suggestions...")
        : applyingChanges
          ? t("Applying selected accessibility changes...")
          : null;

    return (
      <div className="maputnik-style-chat-panel">
        <div className="maputnik-style-chat-panel__messages">
          {!report && !loading && (
            <div className="maputnik-style-chat-panel__placeholder">
              <p>{t("Run an accessibility audit of the current style using WCAG guidance.")}</p>
            </div>
          )}
          {error && <div className="maputnik-style-chat-panel__error">{error}</div>}
          {success && <div className="maputnik-style-chat-panel__success">{success}</div>}
          {loadingMessage && (
            <div className="maputnik-style-chat-panel__loading-status" role="status" aria-live="polite">
              <span className="maputnik-style-chat-panel__thinking-spinner" aria-hidden="true" />
              <span>{loadingMessage}</span>
            </div>
          )}
          {report && (
            <div className="maputnik-style-audit-report">
              <section className="maputnik-style-audit-report__section">
                <h2>{t("What works well")}</h2>
                {report.helpfulAndDoneWell.length > 0 ? (
                  <ul className="maputnik-style-audit-report__bullet-list">
                    {report.helpfulAndDoneWell.map((item, i) => (
                      <li key={`good-${i}`} className="maputnik-style-audit-report__bullet-item">{item}</li>
                    ))}
                  </ul>
                ) : (
                  <p>{t("No clear strengths were detected.")}</p>
                )}
              </section>

              <section className="maputnik-style-audit-report__section maputnik-style-audit-report__section--issues">
                <h2>{t("Standards not fully met")}</h2>
                {report.standardsNotMet.length > 0 ? (
                  <ol className="maputnik-style-audit-report__issue-list">
                    {report.standardsNotMet.map((item, i) => (
                      <li key={`issue-${i}`} className="maputnik-style-audit-report__issue-item">
                        <div className="maputnik-style-audit-report__issue-meta">
                          <span className="maputnik-style-audit-report__priority">{t("Priority")} {i + 1}</span>
                          <strong>{item.criterion}</strong>
                        </div>
                        <p>{item.explanation}</p>
                      </li>
                    ))}
                  </ol>
                ) : (
                  <p>{t("No major standards gaps were identified.")}</p>
                )}
              </section>

              <section className="maputnik-style-audit-report__section">
                <h2>{t("Fonts and sprites")}</h2>
                {report.fontsAndSpritesAssessment.evaluated ? (
                  <ul className="maputnik-style-audit-report__bullet-list">
                    {report.fontsAndSpritesAssessment.findings.map((item, i) => (
                      <li key={`fs-find-${i}`} className="maputnik-style-audit-report__bullet-item">{item}</li>
                    ))}
                  </ul>
                ) : (
                  <p className="maputnik-style-audit-report__notice">
                    {t(
                      "Fonts and sprites may be external resources and cannot always be fully verified from style.json alone. Review icon distinguishability, text legibility, and fallback behavior with real assets."
                    )}
                  </p>
                )}
                {report.fontsAndSpritesAssessment.guidance.length > 0 && (
                  <ul className="maputnik-style-audit-report__bullet-list">
                    {report.fontsAndSpritesAssessment.guidance.map((item, i) => (
                      <li key={`fs-guidance-${i}`} className="maputnik-style-audit-report__bullet-item">{item}</li>
                    ))}
                  </ul>
                )}
              </section>
            </div>
          )}
          {hasSuggestions && (
            <div className="maputnik-style-audit-suggestions">
              <h2>{t("Suggested accessibility changes")}</h2>
              {suggestions.map((suggestion) => (
                <label key={suggestion.id} className="maputnik-style-audit-suggestions__item">
                  <input
                    type="checkbox"
                    checked={selectedSuggestionIds.includes(suggestion.id)}
                    onChange={() => this.onToggleSuggestion(suggestion.id)}
                    disabled={applyingChanges}
                  />
                  <span className="maputnik-style-audit-suggestions__content">
                    <strong className="maputnik-style-audit-suggestions__title">{suggestion.title}</strong>
                    <span className="maputnik-style-audit-suggestions__reason">{suggestion.reason}</span>
                  </span>
                </label>
              ))}
            </div>
          )}
          {report && loadingSuggestions && !hasSuggestions && (
            <div className="maputnik-style-audit-suggestions">
              <h2>{t("Suggested accessibility changes")}</h2>
              <div className="maputnik-style-chat-panel__loading-status" role="status" aria-live="polite">
                <span className="maputnik-style-chat-panel__thinking-spinner" aria-hidden="true" />
                <span>{t("Formulating accessibility suggestions...")}</span>
              </div>
            </div>
          )}
        </div>
        <div className="maputnik-style-chat-panel__form">
          <div className="maputnik-style-chat-panel__form-row">
            <button
              type="button"
              className="maputnik-button maputnik-style-chat-panel__submit"
              onClick={this.onEvaluate}
              disabled={loading || loadingSuggestions || applyingChanges}
            >
              {loading ? t("Evaluating...") : t("Evaluate style")}
            </button>
            {report && (
              <button
                type="button"
                className="maputnik-button maputnik-style-chat-panel__submit"
                onClick={this.onSuggestChanges}
                disabled={loading || loadingSuggestions || applyingChanges}
              >
                {loadingSuggestions ? t("Generating suggestions...") : t("Suggest changes")}
              </button>
            )}
            {hasSuggestions && (
              <button
                type="button"
                className="maputnik-button maputnik-style-chat-panel__submit"
                onClick={this.onApplySelectedChanges}
                disabled={!canApply}
              >
                {applyingChanges ? t("Applying changes...") : t("Apply selected changes")}
              </button>
            )}
          </div>
        </div>
      </div>
    );
  }
}

const StyleChatPanel = withTranslation()(StyleChatPanelInternal);
export default StyleChatPanel;
