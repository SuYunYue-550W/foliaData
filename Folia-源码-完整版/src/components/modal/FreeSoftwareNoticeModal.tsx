import React from 'react';
import { ShieldCheck } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import ThemedDialog from '../shared/ThemedDialog';
import { Button } from '@/components/ui';

// src/components/modal/FreeSoftwareNoticeModal.tsx
// 首次启动的免费软件声明。
//
// 为什么会有一个弹窗：Folia 是免费的，但它是从第三方渠道流出去的，有人拿它卖钱。装好第一次
// 打开时把这件事说清楚，比让人在别处看到「付费版」再来问便宜得多。
//
// 只弹一次（按安装计，不按版本）：写 localStorage 标记，见 useStartupExperienceGate。
// 它不是「同意才能用」的协议 —— 右上角关闭和「我知道了」都只是记账，不拦人。

type FreeSoftwareNoticeModalProps = {
    isOpen: boolean;
    isDaylight: boolean;
    onClose: () => void;
};

const FreeSoftwareNoticeModal: React.FC<FreeSoftwareNoticeModalProps> = ({ isOpen, isDaylight, onClose }) => {
    const { t } = useTranslation();

    const primaryBtnClass = isDaylight
        ? 'bg-zinc-900 text-white hover:bg-zinc-700'
        : 'bg-white text-zinc-950 hover:bg-zinc-200';
    const secondaryBtnClass = isDaylight
        ? 'border-zinc-200 text-zinc-600 hover:bg-zinc-100 hover:text-zinc-900'
        : 'border-white/10 text-zinc-300 hover:bg-white/10 hover:text-white';
    const panelBg = isDaylight ? 'bg-zinc-50 border-zinc-200' : 'bg-white/[0.04] border-white/10';
    const textSecondary = isDaylight ? 'text-zinc-500' : 'text-zinc-400';

    return (
        <ThemedDialog
            isOpen={isOpen}
            onClose={onClose}
            isDaylight={isDaylight}
            title={t('freeSoftwareNotice.title', 'Folia 是免费软件')}
            size="m"
        >
            <div className={`space-y-3 text-sm leading-6 ${textSecondary}`}>
                <p>{t('freeSoftwareNotice.freeForever', 'Folia 完全免费，所有功能对所有人开放。')}</p>
                <p>
                    {t('freeSoftwareNotice.noPaidTier', '官方没有付费会员、激活码或「解锁版」，也永远不会向您收取任何费用。')}
                </p>
                <p>
                    {t('freeSoftwareNotice.paidIsScam', '如果您是从第三方渠道付费获得的，那不是官方行为，请尽快申请退款。')}
                </p>
            </div>

            <p className={`mt-4 flex items-start gap-2 rounded-xl border p-3 text-xs leading-5 ${panelBg} ${textSecondary}`}>
                <ShieldCheck size={14} className="mt-0.5 shrink-0" aria-hidden />
                <span>{t('freeSoftwareNotice.usageNotice', '本项目仅供个人学习与技术交流，请勿用于商业盈利用途。')}</span>
            </p>

            <div className="mt-5 flex flex-col gap-2 sm:flex-row sm:justify-end">
                <Button
                    onClick={onClose}
                    className={`rounded-full border px-4 py-2 text-sm font-medium transition ${secondaryBtnClass}`}
                >
                    {t('ui.close', '关闭')}
                </Button>
                <Button
                    onClick={onClose}
                    className={`rounded-full px-5 py-2 text-sm font-semibold transition ${primaryBtnClass}`}
                >
                    {t('freeSoftwareNotice.acknowledge', '我知道了')}
                </Button>
            </div>
        </ThemedDialog>
    );
};

export default FreeSoftwareNoticeModal;
