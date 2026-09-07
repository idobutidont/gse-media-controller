import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as Mpris from 'resource:///org/gnome/shell/ui/mpris.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import {Extension, gettext as _} from 'resource:///org/gnome/shell/extensions/extension.js';



import {ArtCache} from './artCache.js';
import {isPlayerWhitelisted, LyricsManager} from './lyrics.js';
import {MediaCard} from './mediaCard.js';
import {MprisManager} from './mpris.js';
import {ScrollingLabel} from './scrollingLabel.js';
import {loopIconName, nextLoopStatus, playPauseIconName, seekOffset,
    setToggleStyle} from './transport.js';

const ROLE = 'media-controls';

/* `atEnd` positions are appended after everything already in that panel box —
 * for "far right" that means past the quick settings menu. */
const PANEL_POSITIONS = {
    'far-left': {box: 'left', atEnd: false},
    'left': {box: 'left', atEnd: true},
    'center': {box: 'center', atEnd: false},
    'right': {box: 'right', atEnd: false},
    'far-right': {box: 'right', atEnd: true},
};

/* Every key the indicator renders from. Each gets a `changed::` handler that
 * refreshes the cache in _readSettings() and re-syncs. */
const PANEL_KEYS = [
    'show-previous',
    'show-play-pause',
    'show-next',
    'show-seek-backward',
    'show-seek-forward',
    'show-shuffle',
    'show-loop',
    'show-player-icon',
    'show-title',
    'show-artist',
    'show-lyrics-in-panel',
    'lyrics-dynamic-scroll-speed',
    'lyrics-dynamic-scroll-multiplier',
    'lyrics-use-app-whitelist',
    'lyrics-app-whitelist',
    'panel-text-width',
    'keep-panel-width-when-idle',
    'scroll-text',
    'scroll-speed',
    'scroll-direction',
    'scroll-loop',
    'hide-when-inactive',
    'controls-on-left',
];


const MediaIndicator = GObject.registerClass(
class MediaIndicator extends PanelMenu.Button {
    _init(extension, settings, artCache, lyricsManager, manager) {
        super._init(0.5, 'Media Controls');

        this._settings = settings;
        this._lyricsManager = lyricsManager;
        this._manager = manager;
        this._orderApplied = null;
        this._lyricsData = null;
        this._lastPositionMicros = 0;
        this._lastMonotonicTime = 0;
        this._lastPositionSyncTime = 0;
        this._lyricsTimerId = 0;
        this._seekedSignalId = 0;
        this._readSettings();

        this.add_style_class_name('mc-panel-button');

        this._disableMenuToggle();

        this._box = new St.BoxLayout({
            style_class: 'mc-panel-box',
            orientation: Clutter.Orientation.HORIZONTAL,
            y_align: Clutter.ActorAlign.CENTER,
        });
        this.add_child(this._box);

        this._buildTextBox();
        this._buildControls();

        this._card = new MediaCard(artCache, lyricsManager, settings);
        this._card.connectObject(
            'activated', () => this.menu.close(),
            'open-preferences', () => {
                this.menu.close();
                try {
                    const promise = extension.openPreferences();
                    if (promise?.catch)
                        promise.catch(err => console.warn(`media-controls: openPreferences: ${err.message}`));
                } catch (e) {
                    console.warn(`media-controls: openPreferences: ${e.message}`);
                }
            },
            /* The menu deliberately stays open: switching players is something
             * you do to look at the other player. */
            'player-selected', (_card, busName) =>
                this._manager.selectPlayer(busName), this);


        this.menu.box.add_style_class_name('mc-card-menu');
        const item = new PopupMenu.PopupBaseMenuItem({
            activate: false,
            reactive: false,
            can_focus: false,
            style_class: 'mc-card-item',
        });
        item.add_child(this._card);
        this.menu.addMenuItem(item);

        this.menu.connectObject('open-state-changed', (_menu, open) => {
            this._card.setActive(open);
            if (open)
                this._card.sync();
        }, this);

        this._lyricsManager.connectObject('lyrics-loaded', (_m, key) => {
            const player = this._manager.activePlayer;
            if (player && this._isLyricsAllowed(player) && this._lyricsManager.trackKey(player.artist, player.title) === key) {
                this._lyricsData = this._lyricsManager.currentLyrics;
                this._updatePanelDisplay();
                this._updateLyricsTimer();
            }
        }, this);

        this._manager.connectObject(
            'changed', () => this.sync(),
            /* A player appearing or leaving changes the switcher even when the
             * player on screen stays put. */
            'players-changed', () => this.sync(), this);

        const onPanelKeyChanged = () => {
            this._readSettings();
            this.sync();
        };
        this._settings.connectObject(
            ...PANEL_KEYS.flatMap(key => [`changed::${key}`, onPanelKeyChanged]),
            this);

        this.connect('destroy', () => this._onDestroy());

        this.sync();
    }


    /**
     * sync() runs on every D-Bus property change — several times a second for
     * players that report progress — and each GSettings read marshals a
     * GVariant. The values only move when one of the handlers above fires, so
     * they are read there and cached here.
     */
    _readSettings() {
        const settings = this._settings;
        this._prefs = {
            showPrevious: settings.get_boolean('show-previous'),
            showPlayPause: settings.get_boolean('show-play-pause'),
            showNext: settings.get_boolean('show-next'),
            showSeekBackward: settings.get_boolean('show-seek-backward'),
            showSeekForward: settings.get_boolean('show-seek-forward'),
            showShuffle: settings.get_boolean('show-shuffle'),
            showLoop: settings.get_boolean('show-loop'),
            showPlayerIcon: settings.get_boolean('show-player-icon'),
            showTitle: settings.get_boolean('show-title'),
            showArtist: settings.get_boolean('show-artist'),
            showLyricsInPanel: settings.get_boolean('show-lyrics-in-panel'),
            lyricsDynamicSpeed: settings.get_boolean('lyrics-dynamic-scroll-speed'),
            lyricsDynamicMultiplier: Math.max(0.1, settings.get_double('lyrics-dynamic-scroll-multiplier')),
            useLyricsWhitelist: settings.get_boolean('lyrics-use-app-whitelist'),
            lyricsWhitelist: settings.get_strv('lyrics-app-whitelist'),
            textWidth: settings.get_int('panel-text-width'),
            keepIdleWidth: settings.get_boolean('keep-panel-width-when-idle'),
            scrollText: settings.get_boolean('scroll-text'),
            scrollSpeed: settings.get_int('scroll-speed'),
            scrollRightToLeft: settings.get_string('scroll-direction') === 'right-to-left',
            scrollLoop: settings.get_boolean('scroll-loop'),
            hideWhenInactive: settings.get_boolean('hide-when-inactive'),
            controlsOnLeft: settings.get_boolean('controls-on-left'),
        };
    }


    /**
     * PanelMenu.Button opens its menu from a Clutter.ClickGesture that
     * recognizes on press. Gestures are fed from the capture phase, so the
     * gesture claimed every click before the control buttons nested inside us
     * could see it — pressing a control opened the card and the control itself
     * never emitted `clicked`. We drop the gesture and toggle from vfunc_event
     * instead, where the press can be attributed to the actor it landed on.
     */
    _disableMenuToggle() {
        /* Shells before the gesture port have no ClickGesture at all; there the
         * inherited vfunc_event does the toggling, and our override replaces it. */
        if (!Clutter.ClickGesture)
            return;

        for (const action of this.get_actions()) {
            if (action instanceof Clutter.ClickGesture)
                action.set_enabled(false);
        }
    }

    /* A press anywhere on the indicator opens the card, except on the transport
     * controls, which do their own job instead. Toggling on press rather than
     * release matches every other panel menu in the shell. */
    vfunc_event(event) {
        const type = event.type();
        const isPress = type === Clutter.EventType.BUTTON_PRESS ||
                        type === Clutter.EventType.TOUCH_BEGIN;

        if (isPress && this.menu && !this._isOnControls(event))
            this.menu.toggle();

        return Clutter.EVENT_PROPAGATE;
    }

    /**
     * Hit-test the controls box by geometry. `event.get_source()` is null for
     * pointer events here, and picking would report a disabled control as a
     * miss — which would open the card from a greyed-out button.
     */
    _isOnControls(event) {
        if (!this._controlsBox?.visible)
            return false;

        const [x, y] = event.get_coords();
        const [boxX, boxY] = this._controlsBox.get_transformed_position();
        const [width, height] = this._controlsBox.get_transformed_size();

        return x >= boxX && x < boxX + width &&
               y >= boxY && y < boxY + height;
    }

    _buildTextBox() {
        this._textBox = new St.BoxLayout({
            style_class: 'mc-panel-text',
            orientation: Clutter.Orientation.HORIZONTAL,
            y_align: Clutter.ActorAlign.CENTER,
        });

        this._playerIcon = new St.Icon({
            style_class: 'system-status-icon mc-player-icon',
            icon_size: 16,
        });
        this._label = new ScrollingLabel('mc-panel-label');

        this._textBox.add_child(this._playerIcon);
        this._textBox.add_child(this._label);
        this._box.add_child(this._textBox);
    }

    _buildControls() {
        this._controlsBox = new St.BoxLayout({
            style_class: 'mc-panel-controls',
            orientation: Clutter.Orientation.HORIZONTAL,
            y_align: Clutter.ActorAlign.CENTER,
        });

        this._shuffleButton = this._panelButton('media-playlist-shuffle-symbolic',
            () => this._toggleShuffle());
        this._prevButton = this._panelButton('media-skip-backward-symbolic',
            () => this._manager.activePlayer?.previous());
        this._backButton = this._panelButton('media-seek-backward-symbolic',
            () => this._skip(-1));
        this._playButton = this._panelButton('media-playback-start-symbolic',
            () => this._manager.activePlayer?.playPause());
        this._forwardButton = this._panelButton('media-seek-forward-symbolic',
            () => this._skip(1));
        this._nextButton = this._panelButton('media-skip-forward-symbolic',
            () => this._manager.activePlayer?.next());
        this._loopButton = this._panelButton('media-playlist-repeat-symbolic',
            () => this._cycleLoop());

        this._controlsBox.add_child(this._shuffleButton);
        this._controlsBox.add_child(this._prevButton);
        this._controlsBox.add_child(this._backButton);
        this._controlsBox.add_child(this._playButton);
        this._controlsBox.add_child(this._forwardButton);
        this._controlsBox.add_child(this._nextButton);
        this._controlsBox.add_child(this._loopButton);
        this._box.add_child(this._controlsBox);
    }

    /** @param {number} direction -1 to rewind, 1 to skip ahead */
    _skip(direction) {
        this._manager.activePlayer?.seek(seekOffset(this._settings, direction));
    }

    _toggleShuffle() {
        const player = this._manager.activePlayer;
        if (!player)
            return;
        player.setShuffle(!player.shuffle);
        this.sync();
    }

    _cycleLoop() {
        const player = this._manager.activePlayer;
        if (!player)
            return;
        player.setLoopStatus(nextLoopStatus(player.loopStatus));
        this.sync();
    }

    _panelButton(iconName, onClick) {
        const button = new St.Button({
            style_class: 'mc-panel-control',
            can_focus: true,
            /* Without this the button fills the panel's height and the round
             * hover fill stretches into a slab. */
            y_align: Clutter.ActorAlign.CENTER,
            child: new St.Icon({
                icon_name: iconName,
                style_class: 'system-status-icon',
                icon_size: 16,
            }),
        });
        button.connect('clicked', onClick);
        return button;
    }

    /** Checks whether lyrics are permitted for the given player based on whitelist rules. */
    _isLyricsAllowed(player) {
        if (!player)
            return false;
        if (!this._prefs.useLyricsWhitelist)
            return true;
        return isPlayerWhitelisted(player, this._prefs.lyricsWhitelist);
    }

    /** The full text; the label itself truncates or scrolls it. */
    _panelText(player) {
        const parts = [];
        if (this._prefs.showTitle && player.title)
            parts.push(player.title);
        if (this._prefs.showArtist && player.artist)
            parts.push(player.artist);
        return parts.join(' · ');
    }

    _updatePanelDisplay(positionMs = null) {
        const player = this._manager.activePlayer;
        if (!player)
            return;

        const prefs = this._prefs;
        const textFallback = this._panelText(player);

        if (!player.isPlaying || !prefs.showLyricsInPanel || !this._isLyricsAllowed(player) || !this._lyricsData || !this._lyricsData.synced || this._lyricsData.lines.length === 0) {
            this._label.setText(textFallback, false);
            this._label.visible = textFallback.length > 0;
            return;
        }

        if (positionMs === null) {
            const now = GLib.get_monotonic_time();
            const elapsedMicros = player.isPlaying ? (now - this._lastMonotonicTime) : 0;
            const currentPosMicros = Math.max(0, this._lastPositionMicros + elapsedMicros);
            positionMs = Math.round(currentPosMicros / 1000);
        }

        const active = this._lyricsData.getActiveLine(positionMs);
        let displayText = textFallback;
        let isLyric = false;
        let lineDurationMs = 0;
        let speedMultiplier = 1.0;

        if (active?.text) {
            displayText = active.text;
            isLyric = true;
            if (prefs.lyricsDynamicSpeed && active.durationMs > 0) {
                lineDurationMs = active.durationMs;
                speedMultiplier = prefs.lyricsDynamicMultiplier || 1.0;
            }
        } else if (active?.isIntro || active?.isOutro) {
            displayText = textFallback;
            isLyric = false;
        }

        this._label.setText(displayText, isLyric, lineDurationMs, speedMultiplier);
        this._label.visible = displayText.length > 0;
    }

    _updateLyricsTimer() {
        const player = this._manager.activePlayer;
        const wanted = player?.isPlaying && this._prefs.showLyricsInPanel &&
            this._isLyricsAllowed(player) &&
            this._lyricsData && this._lyricsData.synced;

        if (wanted && !this._lyricsTimerId) {
            if (this._lastMonotonicTime === 0) {
                this._lastMonotonicTime = GLib.get_monotonic_time();
                this._lastPositionSyncTime = this._lastMonotonicTime;
            }

            this._lyricsTimerId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 300, () => {
                const activePlayer = this._manager.activePlayer;
                if (!activePlayer || !activePlayer.isPlaying) {
                    this._lyricsTimerId = 0;
                    return GLib.SOURCE_REMOVE;
                }

                const now = GLib.get_monotonic_time();

                /* Periodic background D-Bus position resync to prevent drift */
                if (now - this._lastPositionSyncTime > 1500000) {
                    this._lastPositionSyncTime = now;
                    activePlayer.getPosition().then(pos => {
                        if (this._manager.activePlayer === activePlayer) {
                            this._lastPositionMicros = pos;
                            this._lastMonotonicTime = GLib.get_monotonic_time();
                        }
                    });
                }

                const elapsedMicros = this._lastMonotonicTime > 0 ? (now - this._lastMonotonicTime) : 0;
                const currentPosMicros = Math.max(0, this._lastPositionMicros + elapsedMicros);
                this._updatePanelDisplay(Math.round(currentPosMicros / 1000));

                return GLib.SOURCE_CONTINUE;
            });
        } else if (!wanted && this._lyricsTimerId) {
            GLib.Source.remove(this._lyricsTimerId);
            this._lyricsTimerId = 0;
        }
    }

    _trackPlayer(player) {
        if (this._trackedPlayer === player)
            return;

        if (this._trackedPlayer && this._seekedSignalId) {
            this._trackedPlayer.disconnect(this._seekedSignalId);
            this._seekedSignalId = 0;
        }

        this._trackedPlayer = player;
        if (player) {
            this._seekedSignalId = player.connect('seeked', (_p, position) => {
                this._lastPositionMicros = position;
                this._lastMonotonicTime = GLib.get_monotonic_time();
                this._lastPositionSyncTime = this._lastMonotonicTime;
                this._updatePanelDisplay(Math.round(position / 1000));
            });
        }
    }

    sync() {
        const player = this._manager.activePlayer;
        const prefs = this._prefs;
        this._card.setPlayer(player);
        this._card.setPlayers(this._manager.readyPlayers, player);
        this._trackPlayer(player);

        if (!player) {
            this._lyricsData = null;
            if (this._lyricsTimerId) {
                GLib.Source.remove(this._lyricsTimerId);
                this._lyricsTimerId = 0;
            }

            /* Drop the text before hiding: a scrolling label left with content
             * keeps its animation running against an actor nobody can see. */
            this._label.setText('', false);

            if (prefs.hideWhenInactive) {
                if (this.menu.isOpen)
                    this.menu.close();
                this.container.visible = false;
                return;
            }

            /* Idle placeholder */
            this.container.visible = true;
            if (prefs.keepIdleWidth) {
                this._label.setWidth(prefs.textWidth);
                this._label.setText(_('No player'), false);
                this._label.visible = true;
            } else {
                this._label.visible = false;
            }


            this._playerIcon.icon_name = 'audio-x-generic-symbolic';
            this._playerIcon.visible = true;
            this._textBox.visible = true;
            this._controlsBox.visible = false;
            this._applyOrder();
            return;
        }


        this.container.visible = true;

        this._label.setWidth(prefs.textWidth);
        this._label.setScrolling(prefs.scrollText, prefs.scrollSpeed,
            prefs.scrollRightToLeft, prefs.scrollLoop);

        /* Refresh position and lyrics */
        player.getPosition().then(position => {
            if (this._manager.activePlayer === player) {
                this._lastPositionMicros = position;
                this._lastMonotonicTime = GLib.get_monotonic_time();
                this._lastPositionSyncTime = this._lastMonotonicTime;
                this._updatePanelDisplay(Math.round(position / 1000));
            }
        });

        if (this._isLyricsAllowed(player)) {
            this._lyricsManager.resolve(player).then(lyricsData => {
                if (this._manager.activePlayer === player) {
                    this._lyricsData = lyricsData;
                    this._updatePanelDisplay();
                    this._updateLyricsTimer();
                }
            }).catch(() => {});
        } else {
            this._lyricsData = null;
            this._updatePanelDisplay();
            this._updateLyricsTimer();
        }

        this._updatePanelDisplay();
        this._updateLyricsTimer();

        this._playerIcon.visible = prefs.showPlayerIcon;
        if (this._playerIcon.visible)
            this._playerIcon.gicon = player.appIcon;
        this._textBox.visible = this._label.visible || this._playerIcon.visible;

        this._prevButton.visible = prefs.showPrevious;
        this._playButton.visible = prefs.showPlayPause;
        this._nextButton.visible = prefs.showNext;

        /* Skipping needs Seek(); a player without it gets no skip buttons. */
        this._backButton.visible = player.canSeek && prefs.showSeekBackward;
        this._forwardButton.visible = player.canSeek && prefs.showSeekForward;

        /* Shuffle and loop are optional MPRIS properties; a player that does
         * not implement them gets no button, whatever the setting says. */
        this._shuffleButton.visible = prefs.showShuffle && player.canShuffle;
        this._loopButton.visible = prefs.showLoop && player.canLoop;

        this._controlsBox.visible = this._prevButton.visible ||
            this._playButton.visible || this._nextButton.visible ||
            this._backButton.visible || this._forwardButton.visible ||
            this._shuffleButton.visible || this._loopButton.visible;

        this._playButton.child.icon_name = playPauseIconName(player);
        this._loopButton.child.icon_name = loopIconName(player.loopStatus);
        setToggleStyle(this._shuffleButton, player.shuffle === true);
        setToggleStyle(this._loopButton,
            player.canLoop && player.loopStatus !== 'None');

        this._setSensitive(this._prevButton, player.canGoPrevious);
        this._setSensitive(this._nextButton, player.canGoNext);
        this._setSensitive(this._playButton, player.canPlay);

        this._applyOrder();
    }

    _setSensitive(actor, sensitive) {
        actor.reactive = sensitive;
        actor.opacity = sensitive ? 255 : 100;
    }

    /* set_child_at_index() re-inserts the actor and queues a relayout even when
     * the index does not move, so only act on a real change. */
    _applyOrder() {
        const controlsFirst = this._prefs.controlsOnLeft;
        if (controlsFirst === this._orderApplied)
            return;

        this._orderApplied = controlsFirst;
        this._box.set_child_at_index(this._controlsBox, controlsFirst ? 0 : 1);
    }

    _onDestroy() {
        if (this._lyricsTimerId) {
            GLib.Source.remove(this._lyricsTimerId);
            this._lyricsTimerId = 0;
        }
        if (this._trackedPlayer && this._seekedSignalId) {
            this._trackedPlayer.disconnect(this._seekedSignalId);
            this._seekedSignalId = 0;
        }
        this._trackedPlayer = null;
        this._lyricsData = null;
    }
});

export default class MediaControlsExtension extends Extension {
    enable() {
        this._origAddPlayer = null;
        this._settings = this.getSettings();
        this._artCache = new ArtCache();
        this._lyricsManager = new LyricsManager();
        this._manager = new MprisManager();
        this._applyExclusivePlayback();
        this._indicator = new MediaIndicator(this, this._settings, this._artCache, this._lyricsManager, this._manager);

        const {box, index} = this._placement();
        Main.panel.addToStatusArea(ROLE, this._indicator, index, box);

        /* addToStatusArea unconditionally shows the container, which would undo
         * the "hide when nothing is playing" state chosen during construction. */
        this._indicator.sync();

        this._updateMediaNotificationVisibility();

        this._settings.connectObject(
            'changed::panel-position', () => this._reposition(),
            'changed::pause-others-on-play', () => this._applyExclusivePlayback(),
            'changed::hide-media-notification', () => this._updateMediaNotificationVisibility(),
            this);
    }

    _updateMediaNotificationVisibility(shouldReset = false) {
        const hide = !shouldReset && this._settings.get_boolean('hide-media-notification');
        const MprisSource = Mpris.MprisSource ?? Mpris.MediaSection;
        const dateMenu = Main.panel?.statusArea?.dateMenu;
        const messageList = dateMenu?._messageList;
        const mediaSource = messageList?._messageView?._mediaSource ?? messageList?._mediaSection;

        if (!MprisSource || !mediaSource)
            return;

        if (this._origAddPlayer && !hide) {
            MprisSource.prototype._addPlayer = this._origAddPlayer;
            this._origAddPlayer = null;
            try {
                mediaSource._onProxyReady?.();
            } catch (e) {
                console.warn(`media-controls: restoring media notification failed: ${e.message}`);
            }
        } else if (!this._origAddPlayer && hide) {
            this._origAddPlayer = MprisSource.prototype._addPlayer;
            MprisSource.prototype._addPlayer = function () {};
            if (mediaSource._players) {
                for (const player of mediaSource._players.values()) {
                    try {
                        mediaSource._onNameOwnerChanged?.(null, null, [player._busName, player._busName, '']);
                    } catch {
                        try {
                            player.destroy?.();
                        } catch {}
                    }
                }
            }
        }
    }

    /* The manager does the pausing, but the setting lives here: mpris.js knows
     * nothing about GSettings keys. */
    _applyExclusivePlayback() {
        this._manager.exclusivePlayback =
            this._settings.get_boolean('pause-others-on-play');
    }

    _panelBoxes() {
        return {
            left: Main.panel._leftBox,
            center: Main.panel._centerBox,
            right: Main.panel._rightBox,
        };
    }

    /* Resolve the setting to a concrete box and child index. The index is
     * computed rather than passed as -1 so the append case is unambiguous. */
    _placement() {
        const key = this._settings.get_string('panel-position');
        const {box, atEnd} = PANEL_POSITIONS[key] ?? PANEL_POSITIONS['right'];
        const boxActor = this._panelBoxes()[box];
        return {
            box,
            boxActor,
            index: atEnd ? boxActor.get_n_children() : 0,
        };
    }

    /* Re-parenting keeps the indicator's statusArea role and menu registration
     * intact, unlike destroying and re-adding it. */
    _reposition() {
        if (!this._indicator)
            return;

        const container = this._indicator.container;
        container.get_parent()?.remove_child(container);

        /* Recompute after the removal so the end index excludes ourselves. */
        const {boxActor, index} = this._placement();
        boxActor.insert_child_at_index(container, index);
    }

    disable() {
        this._updateMediaNotificationVisibility(true);

        /* The extension has no `destroy` signal, so unlike the indicator this
         * owner needs the explicit disconnect. */
        this._settings.disconnectObject(this);

        this._indicator?.destroy();
        this._indicator = null;

        this._manager?.destroy();
        this._manager = null;

        this._lyricsManager?.destroy();
        this._lyricsManager = null;

        this._artCache?.destroy();
        this._artCache = null;

        this._settings = null;
    }
}

