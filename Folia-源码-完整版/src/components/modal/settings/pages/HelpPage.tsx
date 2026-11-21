import React from 'react';
import { AudioLines, ChevronRight, CircleHelp, ExternalLink, Lightbulb, Sparkles, type LucideIcon } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { openPonderNavigation } from '../../../../services/ponder/pagePonderTarget';
import { BUILD_KIND_TAGS, getBuildKind } from '../../../../utils/buildProvenance';
import { PRIMARY_MODIFIER_LABEL } from '../../../../utils/platform';
import { HELP_TAB_PLAYER_CONTROLS, HELP_TAB_PRIMARY_SHORTCUTS } from '../../userGuideContent';
import { Button, CopyButton, Group, Keys, Row, type SettingsGroupDef } from '../kit';
import { openOutsideLink } from '../../../../utils/system/outsideLink';
import { hasElectronBridge, isCapacitorAndroid } from '../../../../platform/runtime';
import { RELEASES_PAGE_MIRRORS, RELEASES_PAGE_URL } from '../../../../services/releaseUrls';
import AndroidUpdatePanel from '../AndroidUpdatePanel';
import { FoundUpdateRow } from './FoundUpdateRow';
import { iconLabel } from './iconLabel';
import { Button as UiButton } from '@/components/ui';

// src/components/modal/settings/pages/HelpPage.tsx
// The 帮助 page, reached from the foot of the side list: entry cards (the release notes, the
// Ponder tutorials, the audio effects console), the keyboard shortcuts and the player's keys side
// by side, where to get help, and the version with a found update and the project link. A build that is not this repository's own says so
// under its version. It is not a settings category, so it is not in pages/index.ts and the search
// does not list it; the settings window mounts it itself and hands it the dialogs it opens.

// 本仓库的发布地址。
const REPOSITORY_URL = 'https://github.com/SuYunYue-550W/foliaData';
const REPOSITORY_NAME = 'SuYunYue-550W/foliaData';
const BUILD_KIND = getBuildKind();
const VERSION_INFO = (__DOCKER_STACK_VERSION__
    ? `${__APP_VERSION_LABEL__} v${__APP_VERSION__} · Stack ${__DOCKER_STACK_VERSION__} · ${__COMMIT_HASH__}`
    : `${__APP_VERSION_LABEL__} v${__APP_VERSION__} - ${__GIT_BRANCH__} - ${__COMMIT_HASH__}`)
    // Self-hosted and unofficial builds always carry a tag, in English, so a line pasted into an
    // issue says where the build came from.
    + (BUILD_KIND === 'official' ? '' : ` · ${BUILD_KIND_TAGS[BUILD_KIND]}`);

/**
 * 音频效果器那几页的走法。不跳转、不预设 —— 手机上没有滑杆之外的入口，
 * 桌面端又容易在「设置」里翻半天。一页一行，写清叫什么、做什么。
 * key 是 i18n 的标签名，descKey 是那一行下面的说明。
 */
const AUDIO_EFFECT_STEPS: ReadonlyArray<{ id: string; labelKey: string; descKey: string }> = [
    { id: 'open', labelKey: 'help.audioEffectsOpen', descKey: 'help.audioEffectsOpenNote' },
    { id: 'immersive', labelKey: 'help.audioEffectsImmersive', descKey: 'help.audioEffectsImmersiveNote' },
    { id: 'preset', labelKey: 'help.audioEffectsPreset', descKey: 'help.audioEffectsPresetNote' },
];

const SHORTCUTS: SettingsGroupDef = { id: 'helpShortcuts', titleKey: 'help.keyboardShortcuts' };
const PLAYER_KEYS: SettingsGroupDef = { id: 'helpPlayerControls', titleKey: 'help.playerControls' };
const AUDIO_EFFECTS: SettingsGroupDef = { id: 'helpAudioEffects', titleKey: 'help.audioEffects' };
const SUPPORT: SettingsGroupDef = { id: 'helpSupport', titleKey: 'aiHelp.title' };
const ABOUT: SettingsGroupDef = { id: 'helpAbout', titleKey: 'help.version' };

/** Two columns that become one where a column would be narrower than 280px. */
const COLUMNS_CLASS = 'grid grid-cols-[repeat(auto-fit,minmax(min(100%,280px),1fr))] gap-x-3';

type TileProps = {
    testId: string;
    icon: LucideIcon;
    title: string;
    line: string;
    onClick: () => void;
};

/** An entry card: an icon, a title, one line, and an arrow. The whole card opens what it names. */
const Tile: React.FC<TileProps> = ({ testId, icon: Icon, title, line, onClick }) => (
    <UiButton
        data-testid={testId}
        onClick={onClick}
        className="group st-t-fast flex min-h-[72px] items-center gap-3.5 rounded-xl bg-[var(--st-card)] px-4 py-3.5 text-left shadow-[0_0_0_1px_var(--st-line)] transition-colors hover:bg-[color-mix(in_srgb,var(--st-card)_93%,var(--st-t1))]"
    >
        <span className="grid h-10 w-10 shrink-0 place-items-center rounded-[10px] bg-[var(--st-fill)] text-[color:var(--st-t1)]">
            <Icon size={18} />
        </span>
        <span className="min-w-0 flex-1">
            <span className="block text-sm font-semibold leading-5 text-[color:var(--st-t1)]">{title}</span>
            <span className="mt-0.5 block text-xs leading-[18px] text-[color:var(--st-t2)]">{line}</span>
        </span>
        <ChevronRight size={16} className="st-t-fast shrink-0 text-[color:var(--st-t3)] transition-transform group-hover:translate-x-0.5" />
    </UiButton>
);

type KeyRowProps = {
    label: string;
    /** The keys are held with the primary modifier. */
    withPrimaryModifier?: boolean;
    /** One key, or two that do a pair of things: shown with a slash between them. */
    keys: ReadonlyArray<string>;
};

/** A compact row of a card: what a shortcut does, and its key caps. */
const KeyRow: React.FC<KeyRowProps> = ({ label, withPrimaryModifier, keys }) => (
    <div className="relative flex min-h-11 items-center justify-between gap-4 px-4 py-2 text-sm leading-5 text-[color:var(--st-t1)] before:absolute before:left-4 before:right-0 before:top-0 before:h-px before:bg-[var(--st-line)] first:before:hidden">
        <span className="min-w-0">{label}</span>
        <span className="inline-flex shrink-0 items-center gap-1">
            {keys.map((key, index) => (
                <React.Fragment key={key}>
                    {index > 0 && <span aria-hidden className="text-[11px] text-[color:var(--st-t3)]">/</span>}
                    <Keys keys={withPrimaryModifier && index === 0 ? [PRIMARY_MODIFIER_LABEL, key] : [key]} />
                </React.Fragment>
            ))}
        </span>
    </div>
);

type HelpPageProps = {
    onOpenReleaseNotes: () => void;
    /** Opens the 遇到问题？ dialog. */
    onOpenAiHelp: () => void;
    /** Opens the audio effects console (均衡 / 压缩 / 混响 / 后置 / 染色 / 沉浸). */
    onOpenAudioEffects: () => void;
    /** A click on the "Project:" label; the settings window counts them. */
    onProjectLabelClick: () => void;
};

const HelpPage: React.FC<HelpPageProps> = ({ onOpenReleaseNotes, onOpenAiHelp, onOpenAudioEffects, onProjectLabelClick }) => {
    const { t } = useTranslation();

    return (
        <>
            <div className={`${COLUMNS_CLASS} mt-5 gap-y-3`}>
                <Tile
                    testId="help-release-notes"
                    icon={Sparkles}
                    title={t('help.releaseNotes')}
                    line={t('help.releaseNotesDescription')}
                    onClick={onOpenReleaseNotes}
                />
                <Tile
                    testId="help-page-ponder"
                    icon={Lightbulb}
                    title={t('help.ponder')}
                    line={t('help.ponderDescription')}
                    onClick={openPonderNavigation}
                />
                <Tile
                    testId="help-audio-effects"
                    icon={AudioLines}
                    title={t('help.audioEffects')}
                    line={t('help.audioEffectsDescription')}
                    onClick={onOpenAudioEffects}
                />
            </div>

            {/* Each group is the first in a cell of its own, so the two headings stand level; the
                cells then sit as far under the cards above as any group does. */}
            <div className={`${COLUMNS_CLASS} mt-2 gap-y-2`}>
                <div>
                    <Group def={SHORTCUTS}>
                        {HELP_TAB_PRIMARY_SHORTCUTS.map(shortcut => (
                            <KeyRow key={shortcut.id} label={t(shortcut.titleKey, shortcut.fallback)} withPrimaryModifier keys={[shortcut.key]} />
                        ))}
                    </Group>
                </div>
                <div>
                    <Group def={PLAYER_KEYS}>
                        {HELP_TAB_PLAYER_CONTROLS.map(control => (
                            <KeyRow
                                key={control.id}
                                label={control.titleKeys.map(titleKey => t(titleKey)).join(' / ')}
                                withPrimaryModifier={control.withPrimaryModifier}
                                keys={control.keys}
                            />
                        ))}
                    </Group>
                </div>
            </div>

            {/*
                音频效果器：一页六签（均衡 / 压缩 / 混响 / 后置 / 染色 / 沉浸）。
                以前帮助页只说「去设置里调」，可这块入口在播放页的功效茶座上，
                手机上根本碰不到「设置」；写成一行行该看什么，比让人自己找有用。
            */}
            <Group def={AUDIO_EFFECTS}>
                {AUDIO_EFFECT_STEPS.map(step => (
                    <Row key={step.id} label={t(step.labelKey)} hint={t(step.descKey)} />
                ))}
                {/*
                  两端差异挂在这行下面；右边那颗是出口 —— 顺手按一下就走，不用回播放页找。
                  不用 Row 的 onClick（那会给整行都挂上箭头和链接语义），只放一颗按钮。
                */}
                <Row label={t('help.audioEffectsOpenAction')} hint={t('help.audioEffectsNativeNote')}>
                    <Button variant="fill" onClick={onOpenAudioEffects}>
                        {t('help.audioEffectsOpenButton')}
                        <ChevronRight size={12} />
                    </Button>
                </Row>
            </Group>

            <Group def={SUPPORT} bare>
                <Row label={iconLabel(CircleHelp, t('aiHelp.openButton'))} onClick={onOpenAiHelp} />
            </Group>

            <Group def={ABOUT} bare>
                <Row label={t('help.version')}>
                    {/* One piece of the row: a version too long for its line breaks inside itself and keeps the button beside it. */}
                    <span className="flex min-w-0 items-center gap-2">
                        <span className="min-w-0 select-text text-right font-mono text-xs text-[color:var(--st-t2)] [overflow-wrap:anywhere]">{VERSION_INFO}</span>
                        <CopyButton text={VERSION_INFO} />
                    </span>
                </Row>
                {BUILD_KIND !== 'official' && (
                    <Row sub notice={t(BUILD_KIND === 'unofficial' ? 'options.unofficialBuildNotice' : 'options.selfHostedBuildNotice')} />
                )}
                <FoundUpdateRow sub />
                {/*
                    安卓端单独一条：上面那块读的是 electron-updater 的状态，在 WebView 里恒为空。
                    手机上没有静默安装这条路 —— 检查、下载进度、下载 / 安装全在这张卡片里。
                */}
                {isCapacitorAndroid() && <AndroidUpdatePanel />}
                {/*
                    Web / 鸿蒙壳没有自动更新（electron-updater 只在桌面、检查面板只在安卓），
                    但用户仍需要一个拿到新安装包的入口。这里给直连 + 两个加速域名，
                    与安卓面板和桌面「下载来源」用的是同一组地址。
                */}
                {!hasElectronBridge() && !isCapacitorAndroid() && (
                    <Row label={t('options.androidUpdateOpenPage')}>
                        <span className="flex flex-wrap items-center justify-end gap-1">
                            <Button variant="quiet" onClick={() => void openOutsideLink(RELEASES_PAGE_URL)}>
                                GitHub <ExternalLink size={12} />
                            </Button>
                            {RELEASES_PAGE_MIRRORS.map(mirror => (
                                <Button
                                    key={mirror.label}
                                    variant="quiet"
                                    onClick={() => void openOutsideLink(mirror.url)}
                                >
                                    {t('options.androidUpdateMirrorPage', { mirror: mirror.label })}
                                </Button>
                            ))}
                        </span>
                    </Row>
                )}
                <Row
                    label={(
                        // The settings window counts the clicks and shows the cat at the seventh.
                        <UiButton onClick={onProjectLabelClick} className="cursor-default">{t('help.madeBy')}</UiButton>
                    )}
                >
                    {/*
                     * 这颗就是「跳仓库」的那颗按钮 —— 它没被删过，但以前用的是 quiet 那一档
                     * （24px 高、次级文字色、没有底），手机上再乘一遍界面缩放就只剩指甲盖那么
                     * 一点，而它的行标题写的是「项目：」—— 一行没有任何链接暗示的字里藏着一粒
                     * 灰字，看上去就跟「仓库链接被删了」一模一样。
                     *
                     * 所以改成常规那一档：有底色和自身高度，看得出来能按；外链图标保留。
                     * 行标题（含那个数到第七下出猫的点击）一个字都不动。
                     */}
                    <Button variant="fill" onClick={() => openOutsideLink(REPOSITORY_URL)}>
                        {REPOSITORY_NAME}
                        <ExternalLink size={12} />
                    </Button>
                </Row>
            </Group>
        </>
    );
};

export default HelpPage;
