const EPHEMERAL_FLAGS = { flags: 64 };

export function isUnknownInteraction(error: any): boolean {
    return error?.code === 10062 || error?.rawError?.code === 10062;
}

export function isAlreadyAcknowledged(error: any): boolean {
    return error?.code === 40060 || error?.rawError?.code === 40060;
}

export async function sendExpiredInteractionNotice(interaction: any, message?: string): Promise<void> {
    if (!interaction?.channel?.isTextBased?.()) return;
    const content = message ?? 'Buttons expired. Please use the latest dashboard message or run /create-session.';
    try {
        await interaction.channel.send({ content });
    } catch (error) {
        console.error('[InteractionSafety] Failed to send expired interaction notice:', error);
    }
}

export async function safeDeferReply(interaction: any, fallbackMessage?: string): Promise<boolean> {
    if (interaction.deferred || interaction.replied) return true;
    try {
        await interaction.deferReply(EPHEMERAL_FLAGS);
        return true;
    } catch (error) {
        if (isAlreadyAcknowledged(error)) {
            return true;
        }
        if (isUnknownInteraction(error)) {
            await sendExpiredInteractionNotice(interaction, fallbackMessage);
            return false;
        }
        throw error;
    }
}

export async function safeEditReply(interaction: any, payload: any, fallbackMessage?: string): Promise<void> {
    try {
        if (interaction.deferred || interaction.replied) {
            await interaction.editReply(payload);
            return;
        }

        if (interaction.isButton?.() || interaction.isStringSelectMenu?.()) {
            const originalUpdate = (interaction as any).__discodeOriginalUpdate || interaction.update;
            await originalUpdate(payload);
            return;
        }

        const originalReply = (interaction as any).__discodeOriginalReply || interaction.reply;
        await originalReply(payload);
    } catch (error) {
        if ((error as any)?.code === 'InteractionNotReplied') {
            try {
                if (interaction.isButton?.() || interaction.isStringSelectMenu?.()) {
                    const originalUpdate = (interaction as any).__discodeOriginalUpdate || interaction.update;
                    await originalUpdate(payload);
                } else {
                    const originalReply = (interaction as any).__discodeOriginalReply || interaction.reply;
                    await originalReply(payload);
                }
                return;
            } catch (fallbackError) {
                if (isAlreadyAcknowledged(fallbackError)) {
                    await interaction.followUp?.(payload).catch(() => {});
                    return;
                }
                if (isUnknownInteraction(fallbackError)) {
                    await sendExpiredInteractionNotice(interaction, fallbackMessage);
                    return;
                }
                throw fallbackError;
            }
        }
        if (isAlreadyAcknowledged(error)) {
            await interaction.followUp?.(payload).catch(() => {});
            return;
        }
        if (isUnknownInteraction(error)) {
            await sendExpiredInteractionNotice(interaction, fallbackMessage);
            return;
        }
        throw error;
    }
}

export async function safeReply(interaction: any, payload: any, fallbackMessage?: string): Promise<void> {
    try {
        if (interaction.deferred || interaction.replied) {
            if (interaction.followUp) {
                await interaction.followUp(payload);
            }
            return;
        }
        const originalReply = (interaction as any).__discodeOriginalReply || interaction.reply;
        await originalReply(payload);
    } catch (error) {
        if (isAlreadyAcknowledged(error)) {
            if (interaction.followUp) {
                await interaction.followUp(payload).catch(() => {});
            }
            return;
        }
        if (isUnknownInteraction(error)) {
            await sendExpiredInteractionNotice(interaction, fallbackMessage);
            return;
        }
        throw error;
    }
}

export async function safeDeferUpdate(interaction: any, fallbackMessage?: string): Promise<boolean> {
    if (interaction.deferred || interaction.replied) return true;
    try {
        await interaction.deferUpdate();
        return true;
    } catch (error) {
        if (isAlreadyAcknowledged(error)) {
            return true;
        }
        if (isUnknownInteraction(error)) {
            await sendExpiredInteractionNotice(interaction, fallbackMessage);
            return false;
        }
        throw error;
    }
}

export async function safeUpdate(interaction: any, payload: any, fallbackMessage?: string): Promise<void> {
    try {
        if (!interaction.deferred && !interaction.replied) {
            const originalUpdate = (interaction as any).__discodeOriginalUpdate || interaction.update;
            await originalUpdate(payload);
        } else {
            await interaction.editReply(payload);
        }
    } catch (error) {
        if (isAlreadyAcknowledged(error)) {
            await interaction.editReply(payload).catch(() => {});
            return;
        }
        if (isUnknownInteraction(error)) {
            await sendExpiredInteractionNotice(interaction, fallbackMessage);
            return;
        }
        throw error;
    }
}

export async function safeImmediateUpdate(interaction: any, payload: any, fallbackMessage?: string): Promise<boolean> {
    try {
        if (interaction.deferred || interaction.replied) {
            await interaction.editReply(payload);
        } else {
            const originalUpdate = (interaction as any).__discodeOriginalUpdate || interaction.update;
            await originalUpdate(payload);
        }
        return true;
    } catch (error) {
        if (isAlreadyAcknowledged(error)) {
            await interaction.editReply(payload).catch(() => {});
            return true;
        }
        if (isUnknownInteraction(error)) {
            await sendExpiredInteractionNotice(interaction, fallbackMessage);
            return false;
        }
        throw error;
    }
}

export function patchInteraction(interaction: any): void {
    if (!interaction || (interaction as any).__discodePatched) return;
    (interaction as any).__discodePatched = true;

    const originalReply = interaction.reply?.bind(interaction);
    const originalUpdate = interaction.update?.bind(interaction);
    const originalDeferReply = interaction.deferReply?.bind(interaction);
    const originalDeferUpdate = interaction.deferUpdate?.bind(interaction);

    (interaction as any).__discodeOriginalReply = originalReply;
    (interaction as any).__discodeOriginalUpdate = originalUpdate;

    if (originalReply) {
        interaction.reply = async (payload: any) => safeReply(interaction, payload);
    }
    if (originalUpdate) {
        interaction.update = async (payload: any) => safeUpdate(interaction, payload);
    }
    if (originalDeferReply) {
        interaction.deferReply = async (payload: any) => {
            if (interaction.deferred || interaction.replied) return;
            return originalDeferReply(payload);
        };
    }
    if (originalDeferUpdate) {
        interaction.deferUpdate = async () => {
            if (interaction.deferred || interaction.replied) return;
            return originalDeferUpdate();
        };
    }
}
