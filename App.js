import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  AccessibilityInfo,
  Alert,
  Animated,
  Image,
  KeyboardAvoidingView,
  Linking,
  Share,
  Modal,
  PanResponder,
  Platform,
  Pressable,
  SafeAreaView,
  ScrollView,
  StatusBar,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import * as SecureStore from 'expo-secure-store';
import * as FileSystem from 'expo-file-system';

// NN-001 persistence keys. NOTE: expo-secure-store rejects "@" in key
// names (it will throw at runtime), so the original @-prefixed keys from
// the NN-001 spec are not usable as literal SecureStore keys. These are
// the same three logical keys with the @ dropped — routine/wellbeing/theme
// data, same as before, just under valid SecureStore key names.
// Bump this with every approved release so it's visible in Settings —
// useful for Richard/testers to reference when reporting issues.
const APP_VERSION = '1.17.2';

// Persistence is split deliberately by SIZE, not by sensitivity.
//
// expo-secure-store documents a 2048-byte limit per value and may silently
// fail above it. Measured against real data, that is roughly 9 notes or 7
// saved places — so any collection that grows with use CANNOT live there.
// Storing them in SecureStore meant a parent's notes would stop saving
// after a handful of entries, with no error shown. That was a genuine
// data-loss bug, fixed here.
//
// SMALL, FIXED-SIZE values stay in SecureStore (encrypted at rest by the
// platform keystore, always well under the limit). GROWING COLLECTIONS
// move to the app's sandboxed document directory.
//
// Be precise about what that second tier does and does not promise:
// these files are app-private (other apps cannot read them) and sit on
// storage that most modern devices encrypt at rest — but that is PLATFORM
// behaviour which varies by device, OS version and user configuration. It
// is NOT encryption applied by NeuroNest, and must not be described as
// equivalent to SecureStore.
//
// This was not a choice between encrypted and unencrypted storage.
// SecureStore physically could not hold these collections past roughly
// nine notes; the real choice was unencrypted, or silently lost. If
// app-level encryption for notes is wanted later, it belongs here as a
// deliberate feature, not as an assumed property of the file system.
const STORAGE_KEYS = {
  wellbeing: 'neuronest_wellbeing_state',
  theme: 'neuronest_theme_preference',
  intro: 'neuronest_intro_seen',
  lastScreen: 'neuronest_last_screen',
  care: 'neuronest_dla_care',
  mobility: 'neuronest_dla_mobility',
};

// Growing collections — file-backed, sized for realistic family use rather
// than unbounded. Whole collections are parsed into memory on load, so this
// suits hundreds of entries, not tens of thousands.
const FILE_KEYS = {
  routine: 'routine.json',
  places: 'places.json',
  notes: 'notes.json',
  cards: 'cards.json',
  moments: 'moments.json',
};

// Old SecureStore keys for the collections that have now moved. Kept only
// so existing data can be migrated across once, then deleted.
const LEGACY_SECURE_KEYS = {
  routine: 'neuronest_routine_state',
  places: 'neuronest_saved_places',
  notes: 'neuronest_notes',
};

const fileUri = name => `${FileSystem.documentDirectory}${name}`;

async function readFile(name) {
  try {
    const info = await FileSystem.getInfoAsync(fileUri(name));
    if (!info.exists) return null;
    return await FileSystem.readAsStringAsync(fileUri(name));
  } catch (e) {
    return null;
  }
}

// One promise chain per file, so writes to the same file always land in
// the order they were requested. Without this, a slow write started first
// could complete AFTER a fast write started second, leaving older data on
// disk — verified reproducible in simulation. A failed write does not break
// the chain: the next queued write still runs.
const writeQueues = {};

// Writes go to a TEMPORARY file first, then swap in to replace the real
// one only once the write has fully succeeded. Writing directly to the
// live file (the previous approach) left a real, if narrow, window: if
// the app or device were killed mid-write, the live file could be left
// half-written and unreadable, corrupting that one collection. Writing to
// a throwaway name first means a crash during the write damages only the
// temp file — the real file is never opened for writing at all, so it is
// either the old complete version or the new complete version, never a
// partial one. Flagged by Charlie's v1.17.0 audit (file-write durability).
//
// The rename/replace step itself is a near-instant metadata operation
// (deleting the old file and moving the temp file into its place), rather
// than rewriting file contents, so the remaining window is negligible by
// comparison to writing the contents themselves.
async function writeFile(name, contents) {
  const previous = writeQueues[name] || Promise.resolve();
  const next = previous
    .catch(() => {})
    .then(async () => {
      const tempUri = fileUri(`${name}.tmp`);
      const liveUri = fileUri(name);
      await FileSystem.writeAsStringAsync(tempUri, contents);
      // Clear any old file first — moveAsync on some platforms does not
      // overwrite an existing destination. idempotent: true means "fine
      // if it wasn't there", not "fine if this fails for another reason".
      await FileSystem.deleteAsync(liveUri, { idempotent: true });
      await FileSystem.moveAsync({ from: tempUri, to: liveUri });
    });
  writeQueues[name] = next;
  // Throws on failure — callers decide what to tell the user. Unlike the
  // old silent .catch(() => {}), a failed save is no longer invisible.
  await next;
}

// Deletes go through the SAME per-file queue as writes. Previously they did
// not, which left a real window: a write already in flight could land after
// the delete and put the user's data back on disk. If the app was terminated
// in that window — tap Reset, see "Reset complete", swipe the app away —
// the deleted notes survived. Queuing the delete closes that window, because
// the delete is guaranteed to run after any write queued before it.
//
// Throws on real failure so the caller can tell the user honestly, rather
// than reporting a successful reset that did not happen.
async function deleteFile(name) {
  const previous = writeQueues[name] || Promise.resolve();
  const next = previous
    .catch(() => {})
    .then(() => FileSystem.deleteAsync(fileUri(name), { idempotent: true }));
  writeQueues[name] = next;
  await next;
}

const LIGHT = {
  bg: '#F6F7F3',
  card: '#FFFFFF',
  ink: '#243238',
  // Accessibility fix: #68777B measured 4.32:1 on the app background and
  // 4.00:1 on nestLight — both fail WCAG AA. This slightly darker variant
  // passes everywhere it is used (4.89:1 worst case).
  muted: '#5C696D',
  border: '#E2E8E4',
  // Accessibility fix: white button text on the old #5D8177 measured
  // 4.31:1 (fails AA). Marginally darker, visually near-identical, and
  // white text now measures 5.17:1.
  nest: '#527469',
  nestLight: '#E7F0EC',
  warm: '#F2C978',
  warmLight: '#FFF4D9',
  coral: '#D96B5F',
  coralLight: '#FCE9E6',
  blue: '#668AA6',
  blueLight: '#EAF1F6',
  purple: '#7B6E91',
  purpleLight: '#EEEAF4',
  green: '#668E68',
  greenLight: '#E9F2E8',
  // Accessibility fix: coral text/icons on coralLight background measured
  // 2.88:1 (fails WCAG AA). This darker, same-hue variant measures 4.66:1.
  // Used only for the Home-screen "I'm struggling right now" row — the
  // identical pairing inside SOSScreen itself is left untouched (frozen).
  // Accessibility fix: blue text on blueLight background (Digital Bystander
  // Pass title, inside SOSScreen) measured 3.20:1 (fails WCAG AA). This
  // darker, same-hue variant measures 4.58:1. Explicitly authorized by
  // Richard as a targeted exception to the SOS freeze — one color value only.
  blueText: '#507089',
  coralText: '#BE3B2D',
  // Accessibility fix: nest used AS TEXT on light backgrounds measured
  // 3.71:1 on nestLight (fails AA). This darker variant is for text and
  // icons only — nest itself remains the fill colour for buttons.
  nestText: '#4E6D64',
  // Text drawn ON a nest-coloured button. White in light mode; in dark
  // mode nest is a LIGHT green, so white would measure 2.06:1 — near
  // invisible. Dark text there instead (7.94:1).
  onNest: '#FFFFFF',
  // Icon/label accent colors for the six Home quick-action tiles. Mirrors
  // the pattern SOSScreen already uses (coralText on coralLight) rather
  // than the flat grey icons the tiles had before: pale tile background,
  // but the icon and label pick up the tile's own darkened hue instead of
  // plain ink. Richard felt the tiles read as washed out; the flat grey
  // icon on every tile — regardless of the tile's own tint — turned out to
  // be why, since it carried no hue contrast, only lightness. nest/blue/
  // coral already had a matching *Text color built for other uses and
  // measured 4.58-4.89:1 on their own *Light background; green/purple/warm
  // never needed one before, so these three are new, each independently
  // checked (4.68-4.83:1) against their own *Light tile background.
  greenText: '#527253',
  purpleText: '#6F6383',
  warmText: '#7E693E',
};

// Module-level alias. SOSScreen is frozen and continues to reference the
// module-scope `C`/`styles` identifiers directly (never migrated to
// useTheme()), so it always renders in the LIGHT palette regardless of the
// app's theme setting — unchanged behavior, zero risk to frozen code.
const C = LIGHT;

// Full dark palette (extends the original chrome-only C_DARK with the
// accent/text colors needed to theme screen interiors, not just app chrome).
// Every text-on-background pairing below was checked against WCAG AA
// (4.5:1) with the same contrast method used for the earlier coral/blue
// fixes; all pass with comfortable margin (5.7:1–14.1:1).
const DARK = {
  bg: '#1B211F',
  card: '#242B29',
  ink: '#EDEFEC',
  muted: '#9AA6A1',
  border: '#33403B',
  nest: '#8FBFAA',
  nestLight: '#28332E',
  warm: '#F2C978',
  warmLight: '#3A331F',
  coral: '#E08475',
  coralLight: '#3A2420',
  blue: '#9CC0DA',
  blueLight: '#212E36',
  purple: '#C3B4DA',
  purpleLight: '#2B2632',
  green: '#9ED0A0',
  greenLight: '#242E24',
  blueText: '#9CC0DA',
  coralText: '#F5B8AC',
  nestText: '#8FBFAA',
  onNest: '#1B211F',
  // Same reasoning as LIGHT.greenText/purpleText/warmText above. In dark
  // mode the base hues themselves already measure 7.6-8.0:1 against their
  // own dark-mode *Light tile background with no adjustment needed — dark
  // mode's contrast headroom is naturally larger here — so these simply
  // reuse the existing base colors rather than deriving new ones.
  greenText: '#9ED0A0',
  purpleText: '#C3B4DA',
  warmText: '#F2C978',
};

// Theme context: lets screens read the active palette/stylesheet without
// prop-drilling isDark through every component. SOSScreen deliberately does
// NOT consume this — see the `C` alias note above.
const ThemeContext = React.createContext({ C: LIGHT, styles: null, isDark: false });
const useTheme = () => React.useContext(ThemeContext);

// CONTENT GOVERNANCE
// -------------------
// Every governed information SECTION carries a visible review date and
// authoritative sources, so it is clear in-app when content was last
// checked rather than it quietly going stale. Note the scope: this is
// per-section, not per-sentence — individual claims within a section are
// not separately sourced. DLA rates are uprated every April, so these MUST be checked
// each spring — the app shows the date to the user so an out-of-date figure
// is obvious rather than silently wrong.
const CONTENT_REVIEW = {
  dlaRates: { reviewed: 'September 2026', taxYear: '2026/27', source: 'gov.uk DLA rates for children' },
  support: { reviewed: 'September 2026' },
};

// One limit per field, applied at BOTH the input and the load validator.
// Previously these disagreed (place notes capped at 500 on input but 2000
// on load; note text capped at 1000 on input but unlimited on load; routine
// items uncapped at both ends), so stored data could exceed what the UI
// would ever allow.
// Contact address for place suggestions and feedback. Deliberately a
// mailto: link opened in the parent's OWN email app, pre-filled — NeuroNest
// never transmits anything itself. That keeps the app out of "user-to-user
// service" territory entirely: it is one person emailing another, exactly
// as if they had typed it. Suggested places are vetted by hand and added in
// a later release rather than appearing live.
const CONTACT_EMAIL = 'hello@neuronest.online';

const FIELD_LIMITS = {
  routineItem: 120,
  noteText: 1000,
  cardTitle: 60,
  cardWho: 40,
  cardLine: 140,
  momentNote: 500,
  placeName: 80,
  placeNote: 500,
};

const DLA = {
  care: [
    ['None', 0],
    ['Lowest', 30.3],
    ['Middle', 76.7],
    ['Highest', 114.6],
  ],
  mobility: [
    ['None', 0],
    ['Lower', 30.3],
    ['Higher', 80.0],
  ],
};

function Header({ title = 'NeuroNest', subtitle, isDark, onToggleTheme }) {
  const { C, styles } = useTheme();
  // The real logo wordmark already contains "NeuroNest", so it replaces the
  // icon+text pair only on the brand header (Home, the default title).
  // Every other screen keeps the small icon next to its own screen title —
  // repeating the full wordmark next to "Family plan"/"Settings"/etc. would
  // just be visual clutter, not a rebrand of every screen.
  const isBrandHeader = title === 'NeuroNest';
  return (
    <View style={styles.header}>
      {isBrandHeader ? (
        <Image
          source={require('./assets/neuronest-logo.png')}
          style={styles.brandLogo}
          resizeMode="contain"
          accessibilityRole="header"
          accessibilityLabel="NeuroNest"
        />
      ) : (
        <View style={styles.logoCircle}><Text style={styles.logo}>⌂</Text></View>
      )}
      <View style={{ flex: 1 }}>
        {!isBrandHeader ? <Text style={styles.brand} accessibilityRole="header">{title}</Text> : null}
        {subtitle ? <Text style={styles.headerSub}>{subtitle}</Text> : null}
      </View>
      {onToggleTheme ? (
        <Pressable onPress={onToggleTheme} style={styles.themeToggle} accessibilityRole="switch" accessibilityLabel="Dark mode" accessibilityState={{ checked: isDark }}>
          <Text style={styles.themeToggleIcon}>{isDark ? '☀' : '☾'}</Text>
        </Pressable>
      ) : null}
    </View>
  );
}

function Card({ children, style }) {
  const { C, styles } = useTheme();
  return <View style={[styles.card, style]}>{children}</View>;
}

function Pill({ label, active, onPress }) {
  const { C, styles } = useTheme();
  return (
    <Pressable onPress={onPress} style={[styles.pill, active && styles.pillActive]} accessibilityRole="radio" accessibilityLabel={label} accessibilityState={{ selected: active }}>
      <Text style={[styles.pillText, active && styles.pillTextActive]}>{label}</Text>
    </Pressable>
  );
}

function HomeScreen({ go, mood, setMood, items }) {
  const { C, styles } = useTheme();
  const now = new Date();
  const hour = now.getHours();
  const greeting = hour < 12 ? 'Good morning' : hour < 18 ? 'Good afternoon' : 'Good evening';
  const weekday = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'][now.getDay()];
  return (
    <ScrollView contentContainerStyle={styles.scroll} showsVerticalScrollIndicator={false}>
      <Header subtitle="A safe place for neurodivergent families" />

      <Text style={styles.greeting}>{greeting} 👋</Text>
      <Text style={styles.body}>Let’s make today a little easier.</Text>

      <Card style={styles.checkCard}>
        <Text style={styles.sectionTitle}>How are things going?</Text>
        <View style={styles.rowGap}>
          {MOOD_OPTIONS.map(([label, emoji]) => (
            <Pressable
              key={label}
              onPress={() => setMood(label)}
              style={[styles.mood, mood === label && styles.moodSelected]}
              accessibilityRole="button"
              accessibilityLabel={`Wellbeing: ${label}`}
              accessibilityState={{ selected: mood === label }}
            >
              <Text style={styles.moodEmoji}>{emoji}</Text>
              <Text style={styles.moodText}>{label}</Text>
            </Pressable>
          ))}
        </View>
      </Card>

      <Pressable
        onPress={() => go('sos')}
        style={styles.sosButton}
        accessibilityRole="button"
        accessibilityLabel="I'm struggling right now"
        accessibilityHint="Opens practical support for the next few minutes"
      >
        <Text style={styles.sosIcon}>♥</Text>
        <View style={{ flex: 1 }}>
          <Text style={styles.sosTitle}>I’m struggling right now</Text>
          <Text style={styles.sosSub}>Practical support for the next few minutes</Text>
        </View>
        <Text style={styles.arrow}>›</Text>
      </Pressable>

      <View style={styles.sectionRow}>
        <Text style={styles.sectionTitle}>Today</Text>
        <Text style={styles.smallMuted}>{weekday}</Text>
      </View>
      <Card>
        {items.map(([title, done], i) => (
          <View key={title + i} style={styles.taskRow}>
            <View style={[styles.check, done && styles.checkDone]}>
              {done ? <Text style={styles.checkMark}>✓</Text> : null}
            </View>
            <View style={{ flex: 1 }}>
              <Text style={[styles.taskTitle, done && styles.taskDone]}>{title}</Text>
            </View>
          </View>
        ))}
        <Pressable onPress={() => go('plan')} style={styles.cardLink} accessibilityRole="button" accessibilityLabel="Open family plan">
          <Text style={styles.cardLinkText}>Open family plan</Text>
        </Pressable>
      </Card>

      <View style={styles.quickGrid}>
        <Quick label="Kids Mode" icon="★" tone="green" onPress={() => go('kids')} />
        <Quick label="Hand-off" icon="↗" tone="nest" onPress={() => go('cards')} />
        <Quick label="Discover" icon="⌖" tone="blue" onPress={() => go('discover')} />
        <Quick label="Support" icon="?" tone="purple" onPress={() => go('support')} />
        <Quick label="Useful links" icon="☎" tone="coral" onPress={() => go('links')} />
        <Quick label="Benefits" icon="£" tone="warm" onPress={() => go('benefits')} />
      </View>

      <Card style={styles.nestCard}>
        <Text style={styles.sectionTitle}>Your Nest</Text>
        <Text style={styles.bodySmall}>Keep the things your family uses most in one place.</Text>
        <View style={styles.nestItems}>
          <NestItem text="Saved routines" onPress={() => go('plan')} />
          <NestItem text="Important notes" onPress={() => go('notes')} />
          <NestItem text="Saved places" onPress={() => go('discover')} />
          <NestItem text="Hand-off cards" onPress={() => go('cards')} />
          <NestItem text="Moments" onPress={() => go('moments')} />
        </View>
      </Card>
    </ScrollView>
  );
}

function Quick({ label, icon, tone, onPress }) {
  const { C, styles } = useTheme();
  const bgMap = { green: C.greenLight, blue: C.blueLight, purple: C.purpleLight, warm: C.warmLight, coral: C.coralLight, nest: C.nestLight };
  // Icon/label picks up the tile's own accent color (see LIGHT/DARK
  // greenText/purpleText/warmText comments) instead of flat C.ink, the
  // same pale-background-plus-saturated-accent pairing SOSScreen already
  // uses for its coral icon on coralLight.
  const textMap = { green: C.greenText, blue: C.blueText, purple: C.purpleText, warm: C.warmText, coral: C.coralText, nest: C.nestText };
  return (
    <Pressable onPress={onPress} style={[styles.quick, { backgroundColor: bgMap[tone] }]} accessibilityRole="button" accessibilityLabel={label}>
      <Text style={[styles.quickIcon, { color: textMap[tone] }]}>{icon}</Text>
      <Text style={[styles.quickText, { color: textMap[tone] }]}>{label}</Text>
    </Pressable>
  );
}

function NestItem({ text, onPress, soon }) {
  const { C, styles } = useTheme();
  const content = (
    <>
      <Text style={styles.dot}>•</Text>
      <Text style={styles.nestText}>{text}</Text>
      {soon ? <Text style={[styles.smallMuted, { marginLeft: 6 }]}>Coming soon</Text> : null}
    </>
  );
  if (onPress) {
    return <Pressable onPress={onPress} style={styles.nestItem} accessibilityRole="button" accessibilityLabel={text}>{content}</Pressable>;
  }
  return <View style={styles.nestItem} accessibilityElementsHidden={false}>{content}</View>;
}

function SOSScreen() {
  const [step, setStep] = useState(0);
  const [pass, setPass] = useState(false);
  const steps = [
    ['Sensory shift', 'Reduce noise, light and demands. Use a low voice and very short instructions. Give space where possible.'],
    ['Body language', 'Avoid intense eye contact. Get lower or to the side rather than standing over the child. Keep hands visible and movements slow.'],
    ['Co-regulation', 'Slow your own breathing. Do not try to reason, negotiate or force compliance in the peak of distress. Focus on safety and reducing overload.'],
  ];
  return (
    <ThemeContext.Provider value={{ C, styles, isDark: false }}>
    <ScrollView contentContainerStyle={styles.scroll}>
      <Header title="Right now" subtitle="You do not have to solve everything at once." />
      <View style={styles.sosHero}>
        <Text style={styles.sosHeroIcon}>♥</Text>
        <Text style={styles.sosHeroTitle}>You’re in the right place.</Text>
        <Text style={styles.sosHeroBody}>Start with safety, space and less sensory input. One small step at a time.</Text>
      </View>

      <Card>
        <Text style={styles.kicker} accessibilityLabel={`Step ${step + 1} of ${steps.length}`}>Step {step + 1} of {steps.length}</Text>
        <Text style={styles.bigTitle}>{steps[step][0]}</Text>
        <Text style={styles.body}>{steps[step][1]}</Text>
        <View style={styles.progressRow}>
          {steps.map((_, i) => <View key={i} style={[styles.progressDot, i <= step && styles.progressDotActive]} />)}
        </View>
        <View style={styles.rowGap}>
          <Pressable disabled={step === 0} onPress={() => setStep(s => s - 1)} style={[styles.secondaryBtn, step === 0 && styles.disabled]} accessibilityRole="button" accessibilityState={{ disabled: step === 0 }} accessibilityLabel="Previous step">
            <Text style={styles.secondaryText}>Back</Text>
          </Pressable>
          <Pressable onPress={() => step === steps.length - 1 ? setPass(true) : setStep(s => s + 1)} style={styles.primaryBtn} accessibilityRole="button" accessibilityLabel={step === steps.length - 1 ? 'Show bystander pass' : `Next step, ${step + 2} of ${steps.length}`}>
            <Text style={styles.primaryText}>{step === steps.length - 1 ? 'Show bystander pass' : 'Next'}</Text>
          </Pressable>
        </View>
      </Card>

      <Pressable onPress={() => setPass(true)} style={styles.passButton} accessibilityRole="button" accessibilityLabel="Digital bystander pass. Show someone nearby what would help.">
        <Text style={styles.passTitle}>Digital bystander pass</Text>
        <Text style={styles.passSub}>Show someone nearby what would help.</Text>
      </Pressable>
      {/* The "add a private incident note" button was removed here. It
          offered something that did not exist — pressing it only said so.
          Building it is not a small job either: an incident note is a dated
          record of a child's distress, which is health data about a minor.
          That changes what category of data NeuroNest holds and pulls in
          the ICO Children's Code, so it needs a deliberate product and
          legal decision rather than being added as a tidy-up. Until that
          decision is made, promising nothing is better than promising
          something the app cannot do. */}
      <Text style={styles.disclaimer}>NeuroNest is not a substitute for emergency services. If you or your child are in immediate danger, call 999 (or your local emergency number).</Text>

      <Modal visible={pass} transparent animationType="fade" onRequestClose={() => setPass(false)}>
        <View style={styles.modalBackdrop} accessibilityViewIsModal={true}>
          <View style={styles.passModal}>
            <Text style={styles.passTitle}>A quick note from us</Text>
            <Text style={styles.passModalBody}>The child may be experiencing sensory overload. They are not being deliberately difficult or naughty.</Text>
            <View style={styles.passRule}><Text style={styles.passRuleText}>Please give us space, avoid staring or filming, and keep noise low.</Text></View>
            <Pressable onPress={() => setPass(false)} style={styles.primaryBtn} accessibilityRole="button" accessibilityLabel="Close bystander pass"><Text style={styles.primaryText}>Close</Text></Pressable>
          </View>
        </View>
      </Modal>
    </ScrollView>
    </ThemeContext.Provider>
  );
}

function KidsScreen({ go }) {
  const { C, styles } = useTheme();
  const DURATIONS = [['5 min', 300], ['10 min', 600], ['15 min', 900]];
  const [durationSeconds, setDurationSeconds] = useState(300);
  const [seconds, setSeconds] = useState(300);
  const [active, setActive] = useState(false);
  const [points, setPoints] = useState([]);
  const [exitHold, setExitHold] = useState(false);
  const [reduceMotion, setReduceMotion] = useState(false);
  const [holdProgress, setHoldProgress] = useState(0);
  const holdRef = useRef(null);
  const HOLD_MS = 1200;
  const timerRef = useRef(null);
  const progress = 1 - seconds / durationSeconds;

  const startExitHold = () => {
    const start = Date.now();
    holdRef.current = setInterval(() => {
      const p = Math.min(1, (Date.now() - start) / HOLD_MS);
      setHoldProgress(p);
      if (p >= 1) {
        clearInterval(holdRef.current);
        setHoldProgress(0);
        setExitHold(false);
        go('home');
      }
    }, 30);
  };
  const cancelExitHold = () => {
    if (holdRef.current) clearInterval(holdRef.current);
    setHoldProgress(0);
  };
  useEffect(() => () => { if (holdRef.current) clearInterval(holdRef.current); }, []);

  useEffect(() => {
    let cancelled = false;
    AccessibilityInfo.isReduceMotionEnabled().then(v => { if (!cancelled) setReduceMotion(v); }).catch(() => {});
    const sub = AccessibilityInfo.addEventListener('reduceMotionChanged', setReduceMotion);
    return () => { cancelled = true; sub && sub.remove && sub.remove(); };
  }, []);

  const visiblePoints = reduceMotion ? points.slice(-1) : points;

  useEffect(() => {
    if (!active) return undefined;
    timerRef.current = setInterval(() => {
      setSeconds(s => {
        if (s <= 1) {
          clearInterval(timerRef.current);
          setActive(false);
          AccessibilityInfo.announceForAccessibility("Time's up. Nice and calm — well done.");
          return 0;
        }
        return s - 1;
      });
    }, 1000);
    return () => clearInterval(timerRef.current);
  }, [active]);

  const responder = useMemo(() => PanResponder.create({
    onStartShouldSetPanResponder: () => true,
    onPanResponderGrant: e => setPoints(p => [...p.slice(-39), { x: e.nativeEvent.locationX, y: e.nativeEvent.locationY }]),
    onPanResponderMove: e => setPoints(p => [...p.slice(-39), { x: e.nativeEvent.locationX, y: e.nativeEvent.locationY }]),
  }), []);

  return (
    <View style={styles.kidsWrap}>
      <View style={styles.kidsTop}>
        <View><Text style={styles.kidsTitle}>Kids Mode</Text><Text style={styles.kidsSub}>A calm space</Text></View>
        <Pressable onPress={() => setExitHold(true)} accessibilityRole="button" accessibilityLabel="Exit Kids Mode"><Text style={styles.exitText}>Exit</Text></Pressable>
      </View>
      <View style={styles.glow} {...responder.panHandlers}>
        {visiblePoints.map((p, i) => <View key={i} style={[styles.glowPoint, { left: p.x - 18, top: p.y - 18, opacity: reduceMotion ? 0.6 : 0.25 + (i / points.length) * 0.65 }]} />)}
        {points.length === 0 && <Text style={styles.glowHint}>Move your finger around the screen</Text>}
      </View>
      <View style={styles.timerCard}>
        <Text style={styles.timerLabel}>{seconds === 0 ? "Time's up" : 'Transition timer'}</Text>
        <Text style={styles.timer}>{String(Math.floor(seconds / 60)).padStart(2, '0')}:{String(seconds % 60).padStart(2, '0')}</Text>
        <View style={styles.timerTrack}><View style={[styles.timerFill, { width: `${progress * 100}%` }]} /></View>
        {seconds === 0 && <Text style={styles.glowHint}>Nice and calm — well done. Press Start for another session.</Text>}
        {!active && (
          <View style={[styles.rowGap, { marginTop: 10 }]}>
            {DURATIONS.map(([label, secs]) => (
              <Pill key={label} label={label} active={durationSeconds === secs} onPress={() => { setDurationSeconds(secs); setSeconds(secs); }} />
            ))}
          </View>
        )}
        <View style={styles.rowGap}>
          <Pressable disabled={active} onPress={() => { setSeconds(durationSeconds); setActive(true); }} style={[styles.kidsBtn, active && styles.disabled]} accessibilityRole="button" accessibilityState={{ disabled: active }} accessibilityLabel={active ? 'Timer running' : `Start ${DURATIONS.find(([, s]) => s === durationSeconds)?.[0] || ''} timer`}><Text style={styles.kidsBtnText}>{active ? 'Running…' : `Start ${DURATIONS.find(([, s]) => s === durationSeconds)?.[0] || ''}`}</Text></Pressable>
          <Pressable onPress={() => { setActive(false); setSeconds(durationSeconds); }} style={styles.kidsBtnSecondary} accessibilityRole="button" accessibilityLabel="Reset timer"><Text style={styles.kidsBtnSecondaryText}>Reset</Text></Pressable>
        </View>
      </View>
      <Modal visible={exitHold} transparent animationType="fade" onRequestClose={() => setExitHold(false)}>
        <View style={styles.modalBackdrop} accessibilityViewIsModal={true}><View style={styles.passModal}>
          <Text style={styles.passTitle}>Leave Kids Mode?</Text>
          <Text style={styles.body}>This is a parent area. Choose below when you’re ready.</Text>
          <Pressable
            onPressIn={startExitHold}
            onPressOut={cancelExitHold}
            style={[styles.primaryBtn, { position: 'relative', overflow: 'hidden' }]}
            accessibilityRole="button"
            accessibilityLabel="Hold to leave Kids Mode"
            accessibilityHint="Press and hold for a second to confirm"
          >
            <View style={[styles.holdFill, { width: `${holdProgress * 100}%` }]} />
            <Text style={styles.primaryText}>Hold to leave Kids Mode</Text>
          </Pressable>
          <Pressable onPress={() => { cancelExitHold(); setExitHold(false); }} style={styles.outlineBtn} accessibilityRole="button" accessibilityLabel="Stay in Kids Mode"><Text style={styles.outlineText}>Stay here</Text></Pressable>
        </View></View>
      </Modal>
    </View>
  );
}

function BenefitsScreen({ care, setCare, mobility, setMobility }) {
  const { C, styles } = useTheme();
  // null means "not chosen yet", which is NOT the same as index 0 ("None",
  // a deliberate £0 choice). The screen previously opened preselected at
  // Middle care and immediately displayed £76.70 a week — a figure the
  // parent had not chosen, on a screen about money they might be counting
  // on. Nothing is shown, and nothing is saved, until they pick both.
  const chosen = care !== null && mobility !== null;
  const careIdx = care === null ? null : Math.min(Math.max(care, 0), DLA.care.length - 1);
  const mobilityIdx = mobility === null ? null : Math.min(Math.max(mobility, 0), DLA.mobility.length - 1);
  const weekly = chosen ? DLA.care[careIdx][1] + DLA.mobility[mobilityIdx][1] : 0;
  return (
    <ScrollView contentContainerStyle={styles.scroll}>
      <Header title="Benefits & support" subtitle="Rate guide, not an eligibility check" />
      <Card style={styles.infoCard}>
        <Text style={styles.sectionTitle}>DLA rate guide</Text>
        <Text style={styles.bodySmall}>
          This shows what the different DLA rates are worth. It does not work out whether your child qualifies, or which rate they would get — only DWP decides that, based on your child’s needs.
        </Text>
        <Text style={[styles.smallMuted, { marginTop: 8 }]}>
          {CONTENT_REVIEW.dlaRates.taxYear} rates, checked {CONTENT_REVIEW.dlaRates.reviewed} against {CONTENT_REVIEW.dlaRates.source}.
        </Text>
        <Text style={[styles.smallMuted, { marginTop: 4 }]}>
          DLA rates change every April. If it is now a later tax year than shown above, check gov.uk for current figures.
        </Text>
      </Card>
      <Choice title="Care component" subtitle="How much extra help your child needs day-to-day compared with other children their age." items={DLA.care} value={care} setValue={setCare} />
      <Choice title="Mobility component" subtitle="How much extra help your child needs getting around compared with other children their age." items={DLA.mobility} value={mobility} setValue={setMobility} />
      <Card style={styles.totalCard}>
        {chosen ? (
          <>
            <Text style={styles.kicker}>These rates add up to</Text>
            <Text style={styles.total}>£{weekly.toFixed(2)} / week</Text>
            <Text style={styles.bodySmall}>£{(weekly * 52).toFixed(2)} per year</Text>
          </>
        ) : (
          <>
            <Text style={styles.sectionTitle}>Choose both rates above</Text>
            <Text style={[styles.bodySmall, { marginTop: 4 }]}>
              Pick a care rate and a mobility rate to see what they add up to. NeuroNest does not guess at either — only DWP decides which rates a child gets.
            </Text>
          </>
        )}
      </Card>
      <Card>
        <Text style={styles.sectionTitle}>Other support to explore</Text>
        {['Universal Credit', 'Carer’s Allowance', 'Council Tax support', 'Blue Badge', 'EHCP / education support'].map(x => <View key={x} style={styles.resourceRow}><Text style={styles.dot}>•</Text><Text style={styles.body}>{x}</Text></View>)}
        <Text style={styles.disclaimer}>These are published rates, not a decision about your child. Whether your child qualifies, and at which rate, is decided by DWP. Check gov.uk or speak to Citizens Advice before making a claim.</Text>
      </Card>
    </ScrollView>
  );
}

function Choice({ title, subtitle, items, value, setValue }) {
  const { C, styles } = useTheme();
  return <Card><Text style={styles.sectionTitle}>{title}</Text>{subtitle ? <Text style={styles.bodySmall}>{subtitle}</Text> : null}<View style={styles.choiceWrap}>{items.map(([name, amount], i) => <Pill key={name} label={`${name} £${amount.toFixed(2)}`} active={value !== null && i === value} onPress={() => setValue(i)} />)}</View></Card>;
}

// HAND-OFF CARDS
// A parent handing their child to someone else — a grandparent, co-parent,
// TA, after-school club — usually has seconds, not minutes. The point of
// this feature is that the handover is a TAP, not a writing exercise: you
// write the card once, then reuse it every time that situation recurs.
//
// Deliberately local-only. The card is rendered on the device and shared
// through the phone's own share sheet (WhatsApp, Messages, email) or simply
// shown on screen. NeuroNest never holds, transmits or sees it — the parent
// shares it themselves, exactly as if they had typed the message. That
// keeps the app's "we collect nothing" position intact.
const CARD_SITUATIONS = [
  'After school',
  'Staying over',
  'A new place',
  'Out and about',
  'At school',
  'General',
];

function cardToText(card) {
  const lines = (card.lines || []).filter(Boolean);
  const who = card.who ? `${card.who} — ` : '';
  return [
    `${who}${card.title}`,
    '',
    'What helps right now:',
    ...lines.map((l, i) => `${i + 1}. ${l}`),
    '',
    'Shared from NeuroNest.',
  ].join('\n');
}

function CardEditor({ existing, onSave, onCancel }) {
  const { C, styles } = useTheme();
  const [who, setWho] = useState(existing ? existing.who : '');
  const [title, setTitle] = useState(existing ? existing.title : CARD_SITUATIONS[0]);
  // Always render exactly four inputs. Padding with only two blanks meant a
  // one-line card opened with three boxes and a four-line card with four.
  const [lines, setLines] = useState(
    existing ? [...existing.lines, '', '', '', ''].slice(0, 4) : ['', '', '', '']
  );
  const [error, setError] = useState('');

  const setLine = (i, v) => setLines(l => l.map((x, j) => (j === i ? v : x)));

  const save = () => {
    const kept = lines.map(l => l.trim()).filter(Boolean);
    if (!title.trim()) { setError('Give the card a situation.'); return; }
    if (kept.length === 0) {
      const msg = 'Add at least one thing that helps.';
      setError(msg);
      AccessibilityInfo.announceForAccessibility(msg);
      return;
    }
    onSave({
      id: existing ? existing.id : `${Date.now()}`,
      who: who.trim(),
      title: title.trim(),
      lines: kept,
    });
  };

  return (
    <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : undefined} keyboardVerticalOffset={Platform.OS === 'ios' ? 90 : 0}>
      <ScrollView contentContainerStyle={styles.scroll} keyboardShouldPersistTaps="handled">
        <Header title={existing ? 'Edit card' : 'New card'} subtitle="Write it once, use it every time" />
        <Pressable onPress={onCancel} style={{ marginBottom: 12, paddingVertical: 8 }} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }} accessibilityRole="button" accessibilityLabel="Cancel and go back">
          <Text style={styles.cardLinkText}>← Cancel</Text>
        </Pressable>

        <Card>
          <Text style={styles.sectionTitle}>When is this for?</Text>
          <View style={[styles.tagRow, { marginTop: 8 }]}>
            {CARD_SITUATIONS.map(s => (
              <Pill key={s} label={s} active={title === s} onPress={() => { setTitle(s); if (error) setError(''); }} />
            ))}
          </View>
          <TextInput
            value={title}
            onChangeText={t => { setTitle(t); if (error) setError(''); }}
            placeholder="Or write your own"
            placeholderTextColor={C.muted}
            style={[styles.fieldInput, { marginTop: 8 }]}
            maxLength={FIELD_LIMITS.cardTitle}
            accessibilityLabel="Situation this card is for"
          />
        </Card>

        <Card>
          <Text style={styles.sectionTitle}>Who is it about?</Text>
          <Text style={[styles.bodySmall, { marginTop: 2 }]}>Optional. A first name is usually enough.</Text>
          <TextInput
            value={who}
            onChangeText={setWho}
            placeholder="e.g. Liam"
            placeholderTextColor={C.muted}
            style={[styles.fieldInput, { marginTop: 8 }]}
            maxLength={FIELD_LIMITS.cardWho}
            accessibilityLabel="Who the card is about"
          />
        </Card>

        <Card>
          <Text style={styles.sectionTitle}>What helps right now?</Text>
          <Text style={[styles.bodySmall, { marginTop: 2, marginBottom: 4 }]}>Short and practical. The person reading this may have thirty seconds.</Text>
          {lines.map((l, i) => (
            <TextInput
              key={i}
              value={l}
              onChangeText={v => { setLine(i, v); if (error) setError(''); }}
              placeholder={i === 0 ? 'e.g. Keep things quiet and low-demand' : `Thing ${i + 1} (optional)`}
              placeholderTextColor={C.muted}
              style={[styles.fieldInput, { marginTop: 8 }]}
              maxLength={FIELD_LIMITS.cardLine}
              accessibilityLabel={`What helps, item ${i + 1}`}
            />
          ))}
          {error ? <Text style={styles.errorText} accessibilityLiveRegion="assertive">{error}</Text> : null}
        </Card>

        <Pressable onPress={save} style={styles.primaryBtn} accessibilityRole="button" accessibilityLabel="Save card">
          <Text style={styles.primaryText}>Save card</Text>
        </Pressable>
        <Text style={styles.disclaimer}>Cards are stored on this device. When you share one, you send it yourself through your own apps — NeuroNest never sees or stores it.</Text>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

function CardsScreen({ cards, setCards, go }) {
  const { C, styles } = useTheme();
  const [editing, setEditing] = useState(null); // 'new' | card object
  const [showing, setShowing] = useState(null);

  const removeCard = card => {
    Alert.alert('Delete this card?', `"${card.title}" will be deleted. This cannot be undone.`, [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Delete', style: 'destructive', onPress: () => setCards(cs => cs.filter(x => x.id !== card.id)) },
    ]);
  };

  const shareCard = async card => {
    try {
      await Share.share({ message: cardToText(card) });
    } catch (e) {
      Alert.alert('Could not share', 'You can still show this card on screen using View.');
    }
  };

  if (editing) {
    return (
      <CardEditor
        existing={editing === 'new' ? null : editing}
        onCancel={() => setEditing(null)}
        onSave={card => {
          setCards(cs => (cs.some(x => x.id === card.id) ? cs.map(x => (x.id === card.id ? card : x)) : [card, ...cs]));
          setEditing(null);
          AccessibilityInfo.announceForAccessibility('Card saved.');
        }}
      />
    );
  }

  return (
    <ScrollView contentContainerStyle={styles.scroll}>
      <Header title="Hand-off cards" subtitle="The right words, ready when you need them" />
      <Pressable onPress={() => go('nest')} style={{ marginBottom: 12, paddingVertical: 8 }} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }} accessibilityRole="button" accessibilityLabel="Back to your nest">
        <Text style={styles.cardLinkText}>← Back to Your Nest</Text>
      </Pressable>

      <Pressable onPress={() => setEditing('new')} style={styles.primaryBtn} accessibilityRole="button" accessibilityLabel="Create a new hand-off card">
        <Text style={styles.primaryText}>+ New card</Text>
      </Pressable>

      {cards.length === 0 ? (
        <Card style={{ marginTop: 14 }}>
          <Text style={styles.sectionTitle}>Nothing saved yet</Text>
          <Text style={[styles.bodySmall, { marginTop: 4 }]}>
            Handing over to a grandparent, a co-parent, a TA or a club leader usually happens in a rush — and you end up explaining the same few things again from scratch.
          </Text>
          <Text style={[styles.bodySmall, { marginTop: 8 }]}>
            Write a card once for a situation that keeps coming round. Next time, it is one tap to send or show.
          </Text>
        </Card>
      ) : (
        cards.map(card => (
          <Card key={card.id} style={{ marginTop: 14 }}>
            <View style={{ flexDirection: 'row', alignItems: 'flex-start' }}>
              <View style={{ flex: 1 }}>
                <Text style={styles.sectionTitle}>{card.title}</Text>
                {card.who ? <Text style={[styles.tag, { alignSelf: 'flex-start', marginTop: 4 }]}>{card.who}</Text> : null}
              </View>
              <Pressable onPress={() => setEditing(card)} style={styles.editBtn} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }} accessibilityRole="button" accessibilityLabel={`Edit ${card.title} card`}>
                <Text style={styles.editBtnText}>✎</Text>
              </Pressable>
              <Pressable onPress={() => removeCard(card)} style={styles.removeBtn} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }} accessibilityRole="button" accessibilityLabel={`Delete ${card.title} card`}>
                <Text style={styles.removeBtnText}>×</Text>
              </Pressable>
            </View>
            <Text style={[styles.bodySmall, { marginTop: 8 }]} numberOfLines={2}>
              {card.lines[0]}{card.lines.length > 1 ? ` and ${card.lines.length - 1} more` : ''}
            </Text>
            <View style={styles.rowGap}>
              <Pressable onPress={() => setShowing(card)} style={styles.secondaryBtn} accessibilityRole="button" accessibilityLabel={`Show ${card.title} card on screen`}>
                <Text style={styles.secondaryText}>View</Text>
              </Pressable>
              <Pressable onPress={() => shareCard(card)} style={styles.primaryBtn} accessibilityRole="button" accessibilityLabel={`Share ${card.title} card`}>
                <Text style={styles.primaryText}>Share</Text>
              </Pressable>
            </View>
          </Card>
        ))
      )}

      <Text style={styles.disclaimer}>Cards stay on this device. Sharing one sends it through your own apps — NeuroNest never sees or stores what you send.</Text>

      <Modal visible={!!showing} transparent animationType="fade" onRequestClose={() => setShowing(null)}>
        <View style={styles.modalBackdrop} accessibilityViewIsModal={true}>
          <View style={[styles.passModal, { maxHeight: '85%' }]}>
            {showing ? (
              <ScrollView>
                <Text style={styles.passTitle}>{showing.who ? `${showing.who} — ${showing.title}` : showing.title}</Text>
                <Text style={[styles.smallMuted, { marginBottom: 10 }]}>What helps right now</Text>
                {showing.lines.map((l, i) => (
                  <View key={i} style={styles.passRule}><Text style={styles.passRuleText}>{i + 1}.  {l}</Text></View>
                ))}
                <Pressable onPress={() => setShowing(null)} style={styles.primaryBtn} accessibilityRole="button" accessibilityLabel="Close card">
                  <Text style={styles.primaryText}>Close</Text>
                </Pressable>
              </ScrollView>
            ) : null}
          </View>
        </View>
      </Modal>
    </ScrollView>
  );
}

function NotesScreen({ notes, setNotes, go }) {
  const { C, styles } = useTheme();
  const [draft, setDraft] = useState('');
  const [editingId, setEditingId] = useState(null);
  const [editDraft, setEditDraft] = useState('');

  const addNote = () => {
    const text = draft.trim();
    if (!text) return;
    setNotes(n => [{ id: `${Date.now()}`, text, created: Date.now() }, ...n]);
    setDraft('');
    AccessibilityInfo.announceForAccessibility('Note saved.');
  };

  const removeNote = (id, text) => {
    const preview = text.length > 40 ? `${text.slice(0, 40)}…` : text;
    Alert.alert('Delete this note?', `"${preview}" will be deleted. This cannot be undone.`, [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Delete', style: 'destructive', onPress: () => setNotes(n => n.filter(x => x.id !== id)) },
    ]);
  };

  const saveEdit = () => {
    const text = editDraft.trim();
    if (text) setNotes(n => n.map(x => (x.id === editingId ? { ...x, text } : x)));
    setEditingId(null);
  };

  return (
    <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : undefined} keyboardVerticalOffset={Platform.OS === 'ios' ? 90 : 0}>
      <ScrollView contentContainerStyle={styles.scroll} keyboardShouldPersistTaps="handled">
        <Header title="Important notes" subtitle="The things you need to hand" />
        <Pressable onPress={() => go('nest')} style={{ marginBottom: 12, paddingVertical: 8 }} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }} accessibilityRole="button" accessibilityLabel="Back to your nest">
          <Text style={styles.cardLinkText}>← Back to Your Nest</Text>
        </Pressable>

        <Card>
          <TextInput
            value={draft}
            onChangeText={setDraft}
            placeholder="e.g. SENCO is Mrs Patel — sencoschool@example.com"
            placeholderTextColor={C.muted}
            style={[styles.fieldInput, { minHeight: 70, textAlignVertical: 'top' }]}
            multiline
            maxLength={FIELD_LIMITS.noteText}
            accessibilityLabel="New note"
          />
          <Pressable onPress={addNote} style={[styles.primaryBtn, { marginTop: 10 }]} accessibilityRole="button" accessibilityLabel="Save note">
            <Text style={styles.primaryText}>Save note</Text>
          </Pressable>
        </Card>

        {notes.length === 0 ? (
          <Card>
            <Text style={styles.sectionTitle}>Nothing saved yet</Text>
            <Text style={[styles.bodySmall, { marginTop: 4 }]}>
              A place for the details you need at short notice and never want to hunt for — the SENCO's name, a reference number, what the paediatrician said, what works when things get hard.
            </Text>
          </Card>
        ) : (
          notes.map(n => (
            <Card key={n.id}>
              {editingId === n.id ? (
                <>
                  <TextInput
                    value={editDraft}
                    onChangeText={setEditDraft}
                    onBlur={saveEdit}
                    style={[styles.fieldInput, { minHeight: 70, textAlignVertical: 'top' }]}
                    multiline
                    maxLength={FIELD_LIMITS.noteText}
                    autoFocus
                    accessibilityLabel="Edit note"
                  />
                  <Pressable onPress={saveEdit} style={[styles.outlineBtn, { marginTop: 8 }]} accessibilityRole="button" accessibilityLabel="Done editing">
                    <Text style={styles.outlineText}>Done</Text>
                  </Pressable>
                </>
              ) : (
                <View style={{ flexDirection: 'row', alignItems: 'flex-start' }}>
                  <Text style={[styles.body, { flex: 1 }]}>{n.text}</Text>
                  <Pressable onPress={() => { setEditingId(n.id); setEditDraft(n.text); }} style={styles.editBtn} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }} accessibilityRole="button" accessibilityLabel="Edit note">
                    <Text style={styles.editBtnText}>✎</Text>
                  </Pressable>
                  <Pressable onPress={() => removeNote(n.id, n.text)} style={styles.removeBtn} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }} accessibilityRole="button" accessibilityLabel="Delete note">
                    <Text style={styles.removeBtnText}>×</Text>
                  </Pressable>
                </View>
              )}
            </Card>
          ))
        )}
        <Text style={styles.disclaimer}>Notes are stored on this device and are not sent anywhere. On some devices they may survive reinstalling the app, so delete anything sensitive before passing the device on.</Text>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

function NestScreen({ mood, items, go, notes, places, cards, moments }) {
  const { C, styles } = useTheme();
  return (
    <ScrollView contentContainerStyle={styles.scroll}>
      <Header title="Your Nest" subtitle="The things your family uses most" />
      <Card>
        <Text style={styles.sectionTitle}>Current wellbeing</Text>
        <Text style={styles.bodySmall}>{mood ? `${MOOD_OPTIONS.find(([label]) => label === mood)?.[1] || ''} ${mood}` : 'Not set yet — check in from Home'}</Text>
      </Card>
      <Card>
        <Text style={styles.sectionTitle}>Saved routine</Text>
        {items.map(([text, done], i) => (
          <View key={text + i} style={styles.taskRow}>
            <View style={[styles.check, done && styles.checkDone]}>
              {done ? <Text style={styles.checkMark}>✓</Text> : null}
            </View>
            <Text style={[styles.taskTitle, done && styles.taskDone]}>{text}</Text>
          </View>
        ))}
      </Card>
      <Card style={styles.nestCard}>
        <Text style={styles.sectionTitle}>Saved for later</Text>
        <Text style={styles.bodySmall}>Everything you have kept, in one place.</Text>
        <View style={styles.nestItems}>
          <NestItem
            text={notes.length === 0 ? 'Important notes' : `Important notes (${notes.length})`}
            onPress={() => go('notes')}
          />
          <NestItem
            text={places.length === 0 ? 'Saved places' : `Saved places (${places.length})`}
            onPress={() => go('discover')}
          />
          <NestItem
            text={cards.length === 0 ? 'Hand-off cards' : `Hand-off cards (${cards.length})`}
            onPress={() => go('cards')}
          />
          <NestItem
            text={moments.length === 0 ? 'Moments' : `Moments (${moments.length})`}
            onPress={() => go('moments')}
          />
        </View>
      </Card>
      {/* Settings is a utility, not content — it belongs at the end, and
          inside a Card like every other use of cardLink in the app. It was
          previously a bare link floating between two cards, which read as
          stranded and broke the rhythm of the screen. */}
      <Card>
        <Pressable onPress={() => go('settings')} style={styles.settingsRow} accessibilityRole="button" accessibilityLabel="Settings">
          <View style={{ flex: 1 }}>
            <Text style={styles.sectionTitle}>Settings</Text>
            <Text style={styles.bodySmall}>Dark mode, reset, app version</Text>
          </View>
          <Text style={styles.cardLinkText}>→</Text>
        </Pressable>
      </Card>
    </ScrollView>
  );
}

function SettingsScreen({ isDark, onToggleTheme, onResetData }) {
  const { C, styles } = useTheme();
  const sendFeedback = () => {
    Alert.alert(
      'Send feedback?',
      `This opens your own email app with a blank message to the person who makes NeuroNest.\n\nNothing is sent until you press send yourself. Please do not include anything identifying your child.\n\nEvery message is read, though we cannot always reply.`,
      [
        { text: 'Not now', style: 'cancel' },
        {
          text: 'Open email',
          onPress: () => composeEmail(
            `NeuroNest feedback (v${APP_VERSION})`,
            `What would you like to tell us?\n\n\n\n---\nApp version: ${APP_VERSION}`,
            () => Alert.alert('No email app found', `You can email us at ${CONTACT_EMAIL} instead.`)
          ),
        },
      ]
    );
  };
  const confirmReset = () => {
    Alert.alert(
      'Reset app data?',
      'This permanently deletes everything NeuroNest has saved on this device:\n\n\u2022  Your routine\n\u2022  All your notes\n\u2022  All your saved places\n\u2022  Your wellbeing check-in\n\u2022  Your benefit rate selections\n\u2022  Your theme and app settings\n\nThis cannot be undone.',
      [
        { text: 'Cancel', style: 'cancel' },
        { text: 'Reset', style: 'destructive', onPress: onResetData },
      ]
    );
  };
  return (
    <ScrollView contentContainerStyle={styles.scroll}>
      <Header title="Settings" subtitle="Make NeuroNest feel right for your family" />
      <Card>
        <View style={styles.settingsRow}>
          <View style={{ flex: 1 }}>
            <Text style={styles.sectionTitle}>Dark mode</Text>
            <Text style={styles.bodySmall}>Easier on the eyes in low light</Text>
          </View>
          <Pressable onPress={onToggleTheme} style={styles.themeToggle} accessibilityRole="switch" accessibilityLabel="Dark mode" accessibilityState={{ checked: isDark }}>
            <Text style={styles.themeToggleIcon}>{isDark ? '☀' : '☾'}</Text>
          </Pressable>
        </View>
      </Card>
      <Card>
        <Text style={styles.sectionTitle}>Reset app data</Text>
        <Text style={styles.bodySmall}>Permanently deletes everything saved on this device \u2014 your routine, notes, saved places, wellbeing check-in, benefit selections and settings.</Text>
        <Pressable onPress={confirmReset} style={[styles.outlineBtn, { marginTop: 10, borderColor: C.coral }]} accessibilityRole="button" accessibilityLabel="Reset app data">
          <Text style={[styles.outlineText, { color: C.coralText }]}>Reset app data</Text>
        </Pressable>
      </Card>
      <Card>
        <Text style={styles.sectionTitle}>Tell us what you think</Text>
        <Text style={styles.bodySmall}>NeuroNest is early, and built by one person. What works, what does not, and what is missing all genuinely help.</Text>
        <Pressable onPress={sendFeedback} style={[styles.outlineBtn, { marginTop: 12 }]} accessibilityRole="button" accessibilityLabel="Send feedback by email">
          <Text style={styles.outlineText}>Send feedback</Text>
        </Pressable>
      </Card>
      <Card>
        <Text style={styles.sectionTitle}>About NeuroNest</Text>
        <Text style={styles.bodySmall}>A safe place for neurodivergent families. This is an early build — more settings will appear here as NeuroNest grows.</Text>
        <Text style={[styles.smallMuted, { marginTop: 8 }]}>Version {APP_VERSION}</Text>
      </Card>
    </ScrollView>
  );
}

function PlanScreen({ items, setItems }) {
  const { C, styles } = useTheme();
  const [draft, setDraft] = useState('');
  const [addError, setAddError] = useState('');
  // The item being edited is tracked by its TEXT, not its array position.
  // Position is unstable: the remove button stays live on other rows while
  // an edit is open, so deleting a row above the one being edited used to
  // shift indices underneath it and commit the edit to the wrong item —
  // silently destroying a different routine. Identity is stable, and
  // duplicate text is already prevented on both add and rename, so the
  // text uniquely identifies the row.
  const [editingKey, setEditingKey] = useState(null);
  const [editDraft, setEditDraft] = useState('');

  const norm = s => s.trim().toLowerCase();
  const isDuplicate = (text, excludeKey) =>
    items.some(x => norm(x[0]) !== norm(excludeKey || '') && norm(x[0]) === norm(text));

  const addItem = () => {
    const text = draft.trim();
    if (!text) return;
    if (isDuplicate(text, null)) {
      const msg = 'That routine item is already on your list.';
      setAddError(msg);
      AccessibilityInfo.announceForAccessibility(msg);
      return;
    }
    setAddError('');
    setItems(a => [...a, [text, false]]);
    setDraft('');
  };
  const removeItem = key => {
    setItems(a => a.filter(x => x[0] !== key));
    // If the row being edited is the one removed, drop the edit rather than
    // letting it commit to whatever ends up in that position.
    if (editingKey === key) setEditingKey(null);
  };
  const startEdit = text => { setEditingKey(text); setEditDraft(text); };
  const saveEdit = () => {
    const text = editDraft.trim();
    const key = editingKey;
    setEditingKey(null);
    if (!text || key === null) return;
    // The row may have been removed while the edit was open — commit only
    // if it is still there.
    if (!items.some(x => x[0] === key)) return;
    if (isDuplicate(text, key)) {
      const msg = 'That routine item is already on your list.';
      setAddError(msg);
      AccessibilityInfo.announceForAccessibility(msg);
      return;
    }
    setItems(a => a.map(x => x[0] === key ? [text, x[1]] : x));
  };

  return (
    <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : undefined} keyboardVerticalOffset={Platform.OS === 'ios' ? 90 : 0}>
      <ScrollView contentContainerStyle={styles.scroll} keyboardShouldPersistTaps="handled">
        <Header title="Family plan" subtitle="Simple routines, less mental load" />
        <Card>
          {items.length === 0 ? <Text style={styles.bodySmall}>No routine items yet — add one below.</Text> : items.map(([text, done], i) => (
            <View key={text + i} style={styles.taskRow}>
              {editingKey === text ? (
                <TextInput
                  value={editDraft}
                  onChangeText={setEditDraft}
                  onSubmitEditing={saveEdit}
                  onBlur={saveEdit}
                  style={[styles.addInput, { flex: 1 }]}
                  autoFocus
                  returnKeyType="done"
                  maxLength={FIELD_LIMITS.routineItem}
                  accessibilityLabel="Edit routine item"
                />
              ) : (
                <Pressable onPress={() => setItems(a => a.map(x => x[0] === text ? [x[0], !x[1]] : x))} style={{ flex: 1, flexDirection: 'row', alignItems: 'center' }} accessibilityRole="checkbox" accessibilityLabel={text} accessibilityState={{ checked: done }}>
                  <View style={[styles.check, done && styles.checkDone]}>{done && <Text style={styles.checkMark}>✓</Text>}</View>
                  <Text style={[styles.taskTitle, done && styles.taskDone]}>{text}</Text>
                </Pressable>
              )}
              {editingKey !== text && (
                <Pressable onPress={() => startEdit(text)} style={styles.editBtn} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }} accessibilityRole="button" accessibilityLabel={`Rename ${text}`}>
                  <Text style={styles.editBtnText}>✎</Text>
                </Pressable>
              )}
              <Pressable onPress={() => removeItem(text)} style={styles.removeBtn} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }} accessibilityRole="button" accessibilityLabel={`Remove ${text}`}>
                <Text style={styles.removeBtnText}>×</Text>
              </Pressable>
            </View>
          ))}
          <View style={styles.addRow}>
            <TextInput value={draft} onChangeText={t => { setDraft(t); if (addError) setAddError(''); }} onSubmitEditing={addItem} placeholder="Add a routine item" placeholderTextColor={C.muted} style={styles.addInput} returnKeyType="done" maxLength={FIELD_LIMITS.routineItem} accessibilityLabel="New routine item" />
            <Pressable onPress={addItem} style={styles.addBtn} accessibilityRole="button" accessibilityLabel="Add routine item">
              <Text style={styles.addBtnText}>Add</Text>
            </Pressable>
          </View>
          {addError ? <Text style={styles.errorText} accessibilityLiveRegion="assertive">{addError}</Text> : null}
        </Card>
        <Card><Text style={styles.sectionTitle}>First → Then</Text><View style={styles.firstThen}><Text style={styles.firstBox}>First: Put on shoes</Text><Text style={styles.thenArrow}>→</Text><Text style={styles.thenBox}>Then: Go to park</Text></View></Card>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

// Sensory factors parents can tag a place with. Deliberately the practical
// things that decide whether an outing works, rather than generic review
// categories. Structured as stable ids so that when a sharing backend
// arrives, saved places can sync without a data migration.
const PLACE_TAGS = [
  ['quiet', 'Quiet space available'],
  ['lownoise', 'Low noise'],
  ['nomusic', 'No loud music'],
  ['notcrowded', 'Rarely crowded'],
  ['quiethours', 'Has quiet / sensory hours'],
  ['staff', 'Understanding staff'],
  ['toilets', 'Accessible toilets'],
  ['changing', 'Changing Places facility'],
  ['lighting', 'Soft lighting'],
  ['space', 'Room to move'],
  ['outdoors', 'Outdoor space'],
  ['quickfood', 'Quick service / food'],
  ['ownfood', 'Own food allowed'],
  ['parking', 'Easy parking'],
  ['booking', 'Can book ahead'],
  ['exit', 'Easy to leave quickly'],
  ['predictable', 'Predictable layout / routine'],
];

const VERDICTS = [
  ['worked', 'Worked well', 'green'],
  ['mixed', 'Mixed', 'warm'],
  ['hard', 'Was hard', 'coral'],
];

function AddPlaceScreen({ onSave, onCancel, existingNames }) {
  const { C, styles } = useTheme();
  const [name, setName] = useState('');
  const [note, setNote] = useState('');
  const [tags, setTags] = useState([]);
  const [verdict, setVerdict] = useState('worked');
  const [error, setError] = useState('');

  const toggleTag = id => setTags(t => (t.includes(id) ? t.filter(x => x !== id) : [...t, id]));

  const save = () => {
    const trimmed = name.trim();
    if (!trimmed) {
      const msg = 'Please give the place a name.';
      setError(msg);
      AccessibilityInfo.announceForAccessibility(msg);
      return;
    }
    if (existingNames.some(n => n.toLowerCase() === trimmed.toLowerCase())) {
      const msg = 'You have already saved a place with that name.';
      setError(msg);
      AccessibilityInfo.announceForAccessibility(msg);
      return;
    }
    onSave({ id: `${Date.now()}`, name: trimmed, note: note.trim(), tags, verdict });
  };

  return (
    <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : undefined} keyboardVerticalOffset={Platform.OS === 'ios' ? 90 : 0}>
      <ScrollView contentContainerStyle={styles.scroll} keyboardShouldPersistTaps="handled">
        <Header title="Add a place" subtitle="What worked, so you remember next time" />
        <Pressable onPress={onCancel} style={{ marginBottom: 12, paddingVertical: 8 }} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }} accessibilityRole="button" accessibilityLabel="Cancel and go back">
          <Text style={styles.cardLinkText}>← Cancel</Text>
        </Pressable>

        <Card>
          <Text style={styles.sectionTitle}>Place name</Text>
          <TextInput
            value={name}
            onChangeText={t => { setName(t); if (error) setError(''); }}
            placeholder="e.g. The Corner Café"
            placeholderTextColor={C.muted}
            style={[styles.fieldInput, { marginTop: 8 }]}
            maxLength={FIELD_LIMITS.placeName}
            returnKeyType="done"
            accessibilityLabel="Place name"
          />
          {error ? <Text style={styles.errorText} accessibilityLiveRegion="assertive">{error}</Text> : null}
        </Card>

        <Card>
          <Text style={styles.sectionTitle}>How did it go?</Text>
          <View style={[styles.rowGap, { marginTop: 8 }]}>
            {VERDICTS.map(([id, label]) => (
              <Pill key={id} label={label} active={verdict === id} onPress={() => setVerdict(id)} />
            ))}
          </View>
        </Card>

        <Card>
          <Text style={styles.sectionTitle}>What was it like?</Text>
          <Text style={[styles.bodySmall, { marginTop: 2, marginBottom: 8 }]}>Tap anything that applied. These are the things that tend to decide whether a visit works.</Text>
          <View style={styles.tagRow}>
            {PLACE_TAGS.map(([id, label]) => (
              <Pill key={id} label={label} active={tags.includes(id)} onPress={() => toggleTag(id)} />
            ))}
          </View>
        </Card>

        <Card>
          <Text style={styles.sectionTitle}>Anything worth remembering?</Text>
          <TextInput
            value={note}
            onChangeText={setNote}
            placeholder="e.g. Quieter before 11am. Corner table by the window is best."
            placeholderTextColor={C.muted}
            style={[styles.fieldInput, { marginTop: 8, minHeight: 80, textAlignVertical: 'top' }]}
            multiline
            maxLength={FIELD_LIMITS.placeNote}
            accessibilityLabel="Notes about this place"
          />
        </Card>

        <Pressable onPress={save} style={styles.primaryBtn} accessibilityRole="button" accessibilityLabel="Save place">
          <Text style={styles.primaryText}>Save place</Text>
        </Pressable>
        <Text style={styles.disclaimer}>Saved on this device. Once it is saved you can suggest it for other families — nothing is sent unless you choose to.</Text>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

function DiscoverScreen({ places, setPlaces }) {
  const { C, styles } = useTheme();
  const [adding, setAdding] = useState(false);

  const removePlace = (id, name) => {
    Alert.alert(
      'Remove this place?',
      `"${name}" and any notes you saved with it will be deleted. This cannot be undone.`,
      [
        { text: 'Cancel', style: 'cancel' },
        { text: 'Remove', style: 'destructive', onPress: () => setPlaces(p => p.filter(x => x.id !== id)) },
      ]
    );
  };

  if (adding) {
    return (
      <AddPlaceScreen
        existingNames={places.map(p => p.name)}
        onCancel={() => setAdding(false)}
        onSave={place => {
          setPlaces(p => [place, ...p]);
          setAdding(false);
          AccessibilityInfo.announceForAccessibility(`${place.name} saved.`);
        }}
      />
    );
  }

  // Explain before opening anything. A parent should know this leaves the
  // app, goes to a person, and is entirely optional — before their email
  // app appears, not after.
  const suggestPlace = place => {
    Alert.alert(
      'Suggest this place?',
      `This opens your own email app with the details about ${place.name} already filled in, addressed to the person who makes NeuroNest.\n\nNothing is sent until you press send yourself, and nothing about your child is included — only what you wrote about the place.\n\nSuggestions are read and checked by hand, and may appear in a future update. We cannot always reply.`,
      [
        { text: 'Not now', style: 'cancel' },
        {
          text: 'Open email',
          onPress: () => composeEmail(
            `Place suggestion: ${place.name}`,
            suggestPlaceBody(place),
            () => Alert.alert('No email app found', `You can email the details to ${CONTACT_EMAIL} instead.`)
          ),
        },
      ]
    );
  };

  const verdictTint = { worked: C.greenLight, mixed: C.warmLight, hard: C.coralLight };
  const verdictLabel = id => (VERDICTS.find(v => v[0] === id) || [, 'Saved'])[1];
  const tagLabel = id => (PLACE_TAGS.find(t => t[0] === id) || [, id])[1];

  return (
    <ScrollView contentContainerStyle={styles.scroll}>
      <Header title="Discover" subtitle="Places that work for your family" />

      <Pressable onPress={() => setAdding(true)} style={styles.primaryBtn} accessibilityRole="button" accessibilityLabel="Add a place">
        <Text style={styles.primaryText}>+ Add a place</Text>
      </Pressable>

      {places.length === 0 ? (
        <Card style={{ marginTop: 14 }}>
          <Text style={styles.sectionTitle}>Nothing saved yet</Text>
          <Text style={[styles.bodySmall, { marginTop: 4 }]}>
            Finding places that actually work takes real effort — and it is easy to forget the details by the next time. Save them here as you go: what the noise was like, whether there was somewhere quiet, which table was best.
          </Text>
          <Text style={[styles.bodySmall, { marginTop: 8 }]}>
            Once you have saved a place, you can suggest it for other families — it is checked by hand before it goes anywhere.
          </Text>
        </Card>
      ) : (
        places.map(p => (
          <Card key={p.id} style={{ marginTop: 14 }}>
            <View style={{ flexDirection: 'row', alignItems: 'flex-start' }}>
              <View style={{ flex: 1 }}>
                <Text style={styles.sectionTitle}>{p.name}</Text>
                <Text style={[styles.tag, { backgroundColor: verdictTint[p.verdict] || C.nestLight, alignSelf: 'flex-start', marginTop: 4 }]}>{verdictLabel(p.verdict)}</Text>
              </View>
              <Pressable onPress={() => removePlace(p.id, p.name)} style={styles.removeBtn} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }} accessibilityRole="button" accessibilityLabel={`Remove ${p.name}`}>
                <Text style={styles.removeBtnText}>×</Text>
              </Pressable>
            </View>
            {p.note ? <Text style={[styles.bodySmall, { marginTop: 8 }]}>{p.note}</Text> : null}
            {p.tags && p.tags.length > 0 ? (
              <View style={styles.tagRow}>
                {p.tags.map(t => <Text key={t} style={styles.tag}>{tagLabel(t)}</Text>)}
              </View>
            ) : null}
            <Pressable
              onPress={() => suggestPlace(p)}
              style={[styles.secondaryBtn, { marginTop: 12 }]}
              accessibilityRole="button"
              accessibilityLabel={`Suggest ${p.name} for other families`}
            >
              <Text style={styles.secondaryText}>Suggest for other families</Text>
            </Pressable>
          </Card>
        ))
      )}
    </ScrollView>
  );
}

// Support content. Deliberately practical and non-clinical: general
// strategies widely recommended by UK autism/ADHD organisations, plus
// signposting to authoritative sources. NOT diagnostic advice, and not a
// substitute for a professional. Should be reviewed by a relevant
// professional or partner organisation before public release.
const SUPPORT_TOPICS = [
  {
    id: 'sensory',
    title: 'Autism & sensory overload',
    icon: 'A',
    intro: 'Sensory overload is generally described as what happens when there is more sensory input than a child can process. On that understanding it is not misbehaviour and not something they are choosing. What triggers it, and what it looks like, differs widely from child to child.',
    sections: [
      ['Signs it may be building', 'Covering ears or eyes, becoming very still or very active, repeating phrases, refusing to move, irritability, or withdrawing. Signs differ hugely between children — you will know your own child\u2019s early signals best.'],
      ['What often helps in the moment', 'Reduce input rather than adding to it: lower noise and light, give space, use fewer and shorter words. Offer a familiar comfort item if they have one. Avoid asking questions or reasoning during the peak.'],
      ['What often makes it harder', 'Raised voices, crowding, bright light, being asked to explain themselves, or being told to calm down. Well-meant physical comfort can also overwhelm some children — follow their lead.'],
      ['Afterwards', 'Recovery can take much longer than the episode itself. Keep demands low for a while. It can help to note what happened and what preceded it, so patterns become visible over time.'],
    ],
    links: [
      ['National Autistic Society', 'https://www.autism.org.uk'],
      ['NHS — autism', 'https://www.nhs.uk/conditions/autism/'],
    ],
  },
  {
    id: 'adhd',
    title: 'ADHD',
    icon: 'D',
    intro: 'ADHD affects attention, activity and impulse regulation. It is widely described as a difference in how the brain manages focus and self-regulation, rather than a lack of effort or discipline. How it shows up varies a great deal between children.',
    sections: [
      ['Working with attention, not against it', 'Short, clear, one-step instructions usually land better than lists. Visual reminders often work better than verbal ones. Breaking tasks into visible chunks can reduce the feeling of an impossible wall.'],
      ['Movement is not the enemy', 'For many children, movement helps them think. Fidgeting, standing, or pacing while listening is often regulation rather than rudeness.'],
      ['Transitions are often the hard part', 'Warnings before a change ("two more minutes, then shoes on") tend to help more than sudden switches. NeuroNest\u2019s Kids Mode timer is designed for exactly this.'],
      ['Being kind to yourself too', 'Parenting a child with ADHD is genuinely demanding. Your own regulation affects theirs, so your rest is not a luxury — it is part of the picture.'],
    ],
    links: [
      ['ADHD UK', 'https://adhduk.co.uk'],
      ['NHS — ADHD', 'https://www.nhs.uk/conditions/attention-deficit-hyperactivity-disorder-adhd/'],
    ],
  },
  {
    id: 'meltdowns',
    title: 'Meltdowns & distress',
    icon: '\u2665',
    intro: 'A meltdown is generally understood as an involuntary response to overwhelm — closer to a circuit overload than a tantrum. On that understanding your child is not in control of it and cannot simply stop. Every child is different, and the people who know yours will recognise more than any general description can.',
    sections: [
      ['Safety first, everything else second', 'The only real goals during a meltdown are keeping everyone safe and reducing input. Teaching, consequences and conversations all come later.'],
      ['What tends to help', 'Fewer words. Lower voice. More space. Turning down light and noise. Staying nearby without crowding. Slowing your own breathing — it genuinely affects the room.'],
      ['Meltdown vs. tantrum', 'The distinction usually drawn is that a tantrum has a goal and tends to stop once that goal is met or clearly will not be, whereas a meltdown is not goal-directed and does not respond to bargaining. In practice the line between them is not always obvious in the moment.'],
      ['In public', 'You do not owe strangers an explanation. NeuroNest\u2019s Digital Bystander Pass exists so you can show someone what would help without having to find words.'],
      ['Afterwards', 'Your child may be exhausted, embarrassed or unable to talk about it. Reconnection matters more than debriefing. If it helps, revisit it much later, calmly and briefly.'],
    ],
    links: [
      ['National Autistic Society — meltdowns', 'https://www.autism.org.uk/advice-and-guidance/topics/behaviour/meltdowns'],
      ['NHS 111 — urgent but non-emergency advice', 'https://111.nhs.uk'],
    ],
  },
  {
    id: 'sleep',
    title: 'Sleep',
    icon: 'Z',
    intro: 'Sleep difficulties are very common in neurodivergent children, and often have physical causes (sensory sensitivity, differences in melatonin timing) rather than behavioural ones.',
    sections: [
      ['Predictability usually beats strictness', 'The same simple sequence each night, in the same order, tends to help more than a rigid clock time. Visual sequences can work better than spoken reminders.'],
      ['The sensory environment matters', 'Light, temperature, bedding texture, background noise and even pyjama seams can all be genuine obstacles rather than fussiness. Small environmental changes sometimes achieve what routine changes cannot.'],
      ['Wind-down takes longer than you think', 'A busy brain rarely switches off on command. A longer, duller run-up to bed often works better than a short, cheerful one.'],
      ['When to seek help', 'If sleep problems are persistent and affecting your child\u2019s daily functioning or your own wellbeing, it is worth raising with your GP — there are things that can be looked into rather than simply endured.'],
    ],
    links: [
      ['The Sleep Charity', 'https://thesleepcharity.org.uk'],
      ['NHS — sleep and tiredness', 'https://www.nhs.uk/live-well/sleep-and-tiredness/'],
    ],
  },
  {
    id: 'school',
    title: 'School & reasonable adjustments',
    icon: 'S',
    intro: 'Schools in England have a legal duty to make reasonable adjustments for disabled pupils under the Equality Act 2010. This applies whether or not your child has an EHCP.',
    sections: [
      ['Examples of reasonable adjustments', 'Movement breaks, a quiet space, ear defenders, advance warning of changes, alternative arrangements at lunch or PE, extra time, or adjusted uniform requirements. Adjustments are specific to the child, not a fixed list.'],
      ['Getting it in writing', 'Verbal agreements get forgotten when staff change. Ask for agreed adjustments to be recorded and shared with everyone who teaches your child.'],
      ['Who to talk to', 'The school\u2019s SENCO (Special Educational Needs Coordinator) is usually the right first contact. You can ask for a meeting; you do not need a diagnosis to start a conversation about support.'],
      ['If you are not getting anywhere', 'You can escalate to the headteacher, then the governing body, and seek independent advice. IPSEA and SENDIASS both offer free, expert guidance on your rights.'],
    ],
    links: [
      ['IPSEA — free legal advice on SEND', 'https://www.ipsea.org.uk'],
      ['Find your local SENDIASS', 'https://cyp.iassnetwork.org.uk'],
      ['Gov.uk — Equality Act 2010 guidance', 'https://www.gov.uk/guidance/equality-act-2010-guidance'],
    ],
  },
  {
    id: 'ehcp',
    title: 'EHCP guidance',
    icon: 'E',
    intro: 'An Education, Health and Care Plan (EHCP) is a legally binding document describing a child\u2019s needs and the support they must receive. It is stronger than school-level support because it is enforceable.',
    sections: [
      ['Who can request an assessment', 'A parent or carer can request an EHC needs assessment directly from the local authority — you do not need the school to do it for you, and you do not need their permission.'],
      ['Timescales', 'The local authority must respond to a request within 6 weeks, and the full process should take no longer than 20 weeks from request to final plan. These are legal limits, not targets.'],
      ['If you are refused', 'Refusals are common, and appealing is often worth it. Of the SEN appeals that were decided by the SEND Tribunal in 2024/25, around 99% went in the appellant\u2019s favour — the appellant is usually the parent. Read that carefully: it describes the cases a tribunal decided, not all refusals. Many appeals are settled or withdrawn before reaching a hearing, so it does not mean 99% of refusals get overturned. What it does show is that a refusal is not the end of the road. Getting free specialist advice before appealing is well worth it.'],
      ['Getting help with the process', 'IPSEA and SENDIASS offer free, independent, expert support with requests and appeals. You do not have to navigate this alone, and you do not need to pay for help.'],
      ['The system is being reformed', 'The government has announced changes to how EHCPs will work in future. Current guidance indicates the existing EHCP process and the 20-week timescale continue to apply for now, with changes phased in from around 2029\u201330 onwards. It is worth checking IPSEA or Gov.uk for the current position rather than relying on older information.'],
    ],
    links: [
      ['IPSEA — free legal advice on SEND', 'https://www.ipsea.org.uk'],
      ['Gov.uk — children with SEND', 'https://www.gov.uk/children-with-special-educational-needs'],
      ['Find your local SENDIASS', 'https://cyp.iassnetwork.org.uk'],
    ],
  },
];

function SupportDetailScreen({ topic, onBack }) {
  const { C, styles } = useTheme();
  return (
    <ScrollView contentContainerStyle={styles.scroll}>
      <Header title={topic.title} subtitle="Practical information" />
      <Pressable onPress={onBack} style={{ marginBottom: 12, paddingVertical: 8 }} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }} accessibilityRole="button" accessibilityLabel="Back to quick support">
        <Text style={styles.cardLinkText}>← Back to Quick support</Text>
      </Pressable>
      <Card><Text style={styles.body}>{topic.intro}</Text></Card>
      {topic.sections.map(([heading, text]) => (
        <Card key={heading}>
          <Text style={styles.sectionTitle}>{heading}</Text>
          <Text style={[styles.bodySmall, { marginTop: 4 }]}>{text}</Text>
        </Card>
      ))}
      <Card style={{ backgroundColor: C.nestLight, borderWidth: 0 }}>
        <Text style={styles.sectionTitle}>Where to find more</Text>
        {topic.links.map(([label, url]) => (
          <Pressable
            key={url}
            onPress={() => Linking.openURL(url).catch(() => Alert.alert('Could not open link', `You can visit it directly at:\n\n${url}`))}
            style={styles.nestItem}
            accessibilityRole="link"
            accessibilityLabel={`${label}. Opens in your browser.`}
          >
            <Text style={styles.dot}>•</Text>
            <Text style={[styles.nestText, { flex: 1, textDecorationLine: 'underline' }]}>{label}</Text>
            <Text style={styles.smallMuted}>↗</Text>
          </Pressable>
        ))}
        <Text style={[styles.smallMuted, { marginTop: 8 }]}>These open in your browser, outside NeuroNest.</Text>
      </Card>
      <Text style={[styles.smallMuted, { marginTop: 4 }]}>Last checked {CONTENT_REVIEW.support.reviewed}. Guidance, entitlements and timescales change — if this page is more than a year old, treat it as a starting point and confirm anything important with the sources above.</Text>
      <Text style={styles.disclaimer}>This is general information to help you think things through — not medical, psychological or legal advice, and not a substitute for support from a qualified professional who knows your child.</Text>
    </ScrollView>
  );
}


// Useful links. Organised by what a parent is actually trying to do, not by
// organisation type. Verified September 2026 — see the content review
// schedule; links rot and helpline numbers change, so this needs the same
// annual check as the Support content.
const LINK_GROUPS = [
  {
    id: 'urgent',
    title: 'If you need help now',
    tone: 'coral',
    intro: 'For an emergency, always call 999.',
    items: [
      { name: 'NHS 111', detail: 'Urgent but not an emergency — 24 hours', url: 'https://111.nhs.uk', tel: '111' },
      { name: 'Samaritans', detail: 'If you are struggling to cope — 24 hours, free', url: 'https://www.samaritans.org', tel: '116123' },
      { name: 'YoungMinds Parents Helpline', detail: 'Worried about your child’s mental health', url: 'https://www.youngminds.org.uk/parent/parents-helpline-and-webchat/', tel: '08088025544' },
    ],
  },
  {
    id: 'understanding',
    title: 'Understanding your child',
    tone: 'blue',
    items: [
      { name: 'National Autistic Society', detail: 'Guidance, community and a helpline', url: 'https://www.autism.org.uk' },
      { name: 'ADHD UK', detail: 'Information and support for ADHD', url: 'https://adhduk.co.uk' },
      { name: 'NHS — autism', detail: 'Signs, diagnosis and support', url: 'https://www.nhs.uk/conditions/autism/' },
      { name: 'NHS — ADHD', detail: 'Symptoms, diagnosis and treatment', url: 'https://www.nhs.uk/conditions/attention-deficit-hyperactivity-disorder-adhd/' },
      { name: 'The Sleep Charity', detail: 'Sleep support, including for additional needs', url: 'https://thesleepcharity.org.uk' },
    ],
  },
  {
    id: 'school',
    title: 'School, EHCPs and your rights',
    tone: 'purple',
    intro: 'These are the ones to reach for when you are told no.',
    items: [
      { name: 'IPSEA', detail: 'Free, expert legal advice on SEND rights', url: 'https://www.ipsea.org.uk' },
      { name: 'Find your local SENDIASS', detail: 'Free impartial advice in your area', url: 'https://cyp.iassnetwork.org.uk' },
      { name: 'Gov.uk — children with SEND', detail: 'Official guidance on the SEND system', url: 'https://www.gov.uk/children-with-special-educational-needs' },
      { name: 'Gov.uk — Equality Act guidance', detail: 'What schools legally must do', url: 'https://www.gov.uk/guidance/equality-act-2010-guidance' },
      { name: 'Contact — education advice', detail: 'Help navigating school and EHCPs', url: 'https://contact.org.uk/help-for-families/information-advice-services/education-learning/' },
    ],
  },
  {
    id: 'money',
    title: 'Money, benefits and grants',
    tone: 'warm',
    items: [
      { name: 'Gov.uk — DLA for children', detail: 'The official claim route and current rates', url: 'https://www.gov.uk/disability-living-allowance-children' },
      { name: 'Citizens Advice', detail: 'Free help with claims and appeals', url: 'https://www.citizensadvice.org.uk' },
      { name: 'Turn2us', detail: 'Benefits calculator and grant search', url: 'https://www.turn2us.org.uk' },
      { name: 'Family Fund', detail: 'Grants for families raising a disabled child', url: 'https://www.familyfund.org.uk' },
      { name: 'Cerebra', detail: 'Grants, guides, sleep service and legal advice', url: 'https://cerebra.org.uk' },
      { name: 'Gov.uk — Carer’s Allowance', detail: 'If you care 35+ hours a week', url: 'https://www.gov.uk/carers-allowance' },
    ],
  },
  {
    id: 'you',
    title: 'Support for you',
    tone: 'nest',
    intro: 'Looking after yourself is part of looking after them.',
    items: [
      { name: 'Contact', detail: 'The charity for families with disabled children', url: 'https://contact.org.uk' },
      { name: 'Carers UK', detail: 'Advice and support for unpaid carers', url: 'https://www.carersuk.org' },
      { name: 'Mencap Learning Disability Helpline', detail: 'Free advice line', url: 'https://www.mencap.org.uk', tel: '08088081111' },
      { name: 'Sibs', detail: 'Support for siblings of disabled children', url: 'https://www.sibs.org.uk' },
    ],
  },
];

// Opens the parent's email app with a pre-filled message. Nothing about
// the child is ever included — only the place and what the parent wrote
// about the place.
function composeEmail(subject, body, onFail) {
  const url = `mailto:${CONTACT_EMAIL}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
  Linking.openURL(url).catch(() => onFail());
}

function suggestPlaceBody(place) {
  const tagLabel = id => (PLACE_TAGS.find(t => t[0] === id) || [, id])[1];
  const verdictLabel = (VERDICTS.find(v => v[0] === place.verdict) || [, ''])[1];
  return [
    `Place: ${place.name}`,
    `How it went: ${verdictLabel}`,
    place.tags && place.tags.length ? `What it was like: ${place.tags.map(tagLabel).join(', ')}` : null,
    place.note ? `Notes: ${place.note}` : null,
    '',
    'Roughly where is it? (town or area):',
    '',
    'Anything else worth knowing:',
    '',
  ].filter(l => l !== null).join('\n');
}

// MOMENTS
// A parent's own record of difficult moments, kept so they can say what has
// actually been happening when it matters — an EHCP review, a paediatrician,
// a school meeting. Arriving with dated entries is a different conversation
// from arriving with "it's been hard".
//
// Deliberately NOT a pattern detector. No counts, no trends, no "4 times in
// 2 weeks". Six entries is not a pattern, and a number presented by an app
// carries an authority the underlying data cannot support — especially if a
// parent takes it into a meeting. The app keeps the record; the parent and
// the professionals draw the conclusions.
//
// Called "Moments" rather than "incidents" on purpose. An incident log with
// severity ratings reads as a clinical record and invites everyone to treat
// it as one. This is a parent writing things down about their own child.
const MOMENT_WHERE = [
  ['home', 'Home'], ['school', 'School'], ['transport', 'Transport'],
  ['outdoors', 'Outdoors'], ['social', 'Social'], ['shops', 'Shops'], ['other', 'Somewhere else'],
];

const MOMENT_AROUND = [
  ['noise', 'Noise'], ['change', 'Change'], ['transition', 'Transition'],
  ['crowds', 'Crowds'], ['waiting', 'Waiting'], ['hunger', 'Hunger'],
  ['tiredness', 'Tiredness'], ['demands', 'Too many demands'], ['unknown', 'Not sure'],
];

const MOMENT_HELPED = [
  ['quiet', 'Quiet'], ['time', 'Time'], ['space', 'Space'],
  ['comfort', 'Comfort item'], ['food', 'Food or drink'], ['home', 'Going home'],
  ['company', 'Someone familiar'], ['nothing', 'Nothing really'],
];

const labelFor = (list, id) => (list.find(x => x[0] === id) || [, id])[1];

function formatMomentDate(ts) {
  const d = new Date(ts);
  const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const months = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
  return `${days[d.getDay()]} ${d.getDate()} ${months[d.getMonth()]}`;
}

// Builds the plain-text summary a parent takes to a meeting. The closing
// note is deliberate: it stops the document being mistaken for a clinical
// assessment wherever it ends up, which protects the parent as much as it
// protects NeuroNest.
function buildMomentSummary(moments, rangeLabel) {
  const sorted = [...moments].sort((a, b) => a.when - b.when);
  const lines = [
    'NeuroNest — moments recorded by a parent',
    `${rangeLabel} · ${sorted.length} ${sorted.length === 1 ? 'entry' : 'entries'}`,
    '',
  ];
  sorted.forEach(m => {
    lines.push(`${formatMomentDate(m.when)}${m.where ? `, ${labelFor(MOMENT_WHERE, m.where)}` : ''}`);
    if (m.around && m.around.length) lines.push(`Around it: ${m.around.map(a => labelFor(MOMENT_AROUND, a).toLowerCase()).join(', ')}`);
    if (m.helped && m.helped.length) lines.push(`What helped: ${m.helped.map(h => labelFor(MOMENT_HELPED, h).toLowerCase()).join(', ')}`);
    if (m.note) lines.push(`Note: ${m.note}`);
    lines.push('');
  });
  lines.push('This is a parent\u2019s own record of what they observed.');
  lines.push('It is not a clinical assessment and has not been verified by anyone.');
  return lines.join('\n');
}

function MomentLogScreen({ onSave, onCancel }) {
  const { C, styles } = useTheme();
  const [where, setWhere] = useState(null);
  const [around, setAround] = useState([]);
  const [helped, setHelped] = useState([]);
  const [note, setNote] = useState('');
  const toggle = (setter, id) => setter(v => (v.includes(id) ? v.filter(x => x !== id) : [...v, id]));

  return (
    <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : undefined} keyboardVerticalOffset={Platform.OS === 'ios' ? 90 : 0}>
      <ScrollView contentContainerStyle={styles.scroll} keyboardShouldPersistTaps="handled">
        <Header title="Add a moment" subtitle="However much or little you want to note" />
        <Pressable onPress={onCancel} style={{ marginBottom: 12, paddingVertical: 8 }} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }} accessibilityRole="button" accessibilityLabel="Cancel and go back">
          <Text style={styles.cardLinkText}>← Cancel</Text>
        </Pressable>

        <Card>
          <Text style={styles.sectionTitle}>Where were you?</Text>
          <View style={styles.tagRow}>
            {MOMENT_WHERE.map(([id, label]) => (
              <Pill key={id} label={label} active={where === id} onPress={() => setWhere(where === id ? null : id)} />
            ))}
          </View>
        </Card>

        <Card>
          <Text style={styles.sectionTitle}>What was around it?</Text>
          <Text style={[styles.bodySmall, { marginTop: 2 }]}>Whatever you noticed. This is not about working out a cause.</Text>
          <View style={styles.tagRow}>
            {MOMENT_AROUND.map(([id, label]) => (
              <Pill key={id} label={label} active={around.includes(id)} onPress={() => toggle(setAround, id)} />
            ))}
          </View>
        </Card>

        <Card>
          <Text style={styles.sectionTitle}>What helped?</Text>
          <View style={styles.tagRow}>
            {MOMENT_HELPED.map(([id, label]) => (
              <Pill key={id} label={label} active={helped.includes(id)} onPress={() => toggle(setHelped, id)} />
            ))}
          </View>
        </Card>

        <Card>
          <Text style={styles.sectionTitle}>Anything else?</Text>
          <Text style={[styles.bodySmall, { marginTop: 2 }]}>Optional. A line now can be worth a lot in three months.</Text>
          <TextInput
            value={note}
            onChangeText={setNote}
            placeholder="e.g. End of lunch break. Took about 40 minutes to settle."
            placeholderTextColor={C.muted}
            style={[styles.fieldInput, { marginTop: 8, minHeight: 70, textAlignVertical: 'top' }]}
            multiline
            maxLength={FIELD_LIMITS.momentNote}
            accessibilityLabel="Note about this moment"
          />
        </Card>

        <Pressable
          onPress={() => onSave({ id: `${Date.now()}`, when: Date.now(), where, around, helped, note: note.trim() })}
          style={styles.primaryBtn}
          accessibilityRole="button"
          accessibilityLabel="Save this moment"
        >
          <Text style={styles.primaryText}>Save</Text>
        </Pressable>
        <Text style={styles.disclaimer}>Saved on this device only. Nothing is sent anywhere unless you choose to share a summary yourself.</Text>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

function MomentsScreen({ moments, setMoments, go }) {
  const { C, styles } = useTheme();
  const [adding, setAdding] = useState(false);

  const removeMoment = m => {
    Alert.alert('Delete this moment?', `The entry from ${formatMomentDate(m.when)} will be deleted. This cannot be undone.`, [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Delete', style: 'destructive', onPress: () => setMoments(v => v.filter(x => x.id !== m.id)) },
    ]);
  };

  const shareSummary = (days, rangeLabel) => {
    const cutoff = days === null ? 0 : Date.now() - days * 24 * 60 * 60 * 1000;
    const inRange = moments.filter(m => m.when >= cutoff);
    if (inRange.length === 0) {
      Alert.alert('Nothing in that range', 'There are no moments recorded in that period yet.');
      return;
    }
    Share.share({ message: buildMomentSummary(inRange, rangeLabel) })
      .catch(() => Alert.alert('Could not share', 'You can still read your moments on this screen.'));
  };

  const prepareSummary = () => {
    Alert.alert(
      'Prepare a summary',
      'This writes out your moments as plain text you can email, print or show to someone — useful before a school meeting or an appointment.\n\nNothing is sent until you choose where to send it.',
      [
        { text: 'Cancel', style: 'cancel' },
        { text: 'Last month', onPress: () => shareSummary(31, 'The last month') },
        { text: 'Last 3 months', onPress: () => shareSummary(92, 'The last three months') },
        { text: 'Everything', onPress: () => shareSummary(null, 'All recorded moments') },
      ]
    );
  };

  if (adding) {
    return (
      <MomentLogScreen
        onCancel={() => setAdding(false)}
        onSave={m => {
          setMoments(v => [m, ...v]);
          setAdding(false);
          AccessibilityInfo.announceForAccessibility('Moment saved.');
        }}
      />
    );
  }

  return (
    <ScrollView contentContainerStyle={styles.scroll}>
      <Header title="Moments" subtitle="A record of the harder days, for when you need it" />
      <Pressable onPress={() => go('nest')} style={{ marginBottom: 12, paddingVertical: 8 }} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }} accessibilityRole="button" accessibilityLabel="Back to your nest">
        <Text style={styles.cardLinkText}>← Back to Your Nest</Text>
      </Pressable>

      <Pressable onPress={() => setAdding(true)} style={styles.primaryBtn} accessibilityRole="button" accessibilityLabel="Add a moment">
        <Text style={styles.primaryText}>+ Add a moment</Text>
      </Pressable>

      {moments.length === 0 ? (
        <Card style={{ marginTop: 12 }}>
          <Text style={styles.sectionTitle}>Nothing recorded yet</Text>
          <Text style={[styles.bodySmall, { marginTop: 4 }]}>
            When a day has been hard, a few taps here take about fifteen seconds. Where you were, what was around it, what helped.
          </Text>
          <Text style={[styles.bodySmall, { marginTop: 8 }]}>
            Months later, when someone asks how things have been, you will have more than your memory to go on. You can write it all out as a summary to take to a meeting.
          </Text>
          <Text style={[styles.bodySmall, { marginTop: 8 }]}>
            NeuroNest does not analyse any of this or tell you what it means. It just keeps the record.
          </Text>
        </Card>
      ) : (
        <>
          <Pressable onPress={prepareSummary} style={[styles.secondaryBtn, { marginTop: 12, marginBottom: 4 }]} accessibilityRole="button" accessibilityLabel="Prepare a summary to share">
            <Text style={styles.secondaryText}>Prepare a summary</Text>
          </Pressable>
          {moments.map(m => (
            <Card key={m.id} style={{ marginTop: 12 }}>
              <View style={{ flexDirection: 'row', alignItems: 'flex-start' }}>
                <View style={{ flex: 1 }}>
                  <Text style={styles.sectionTitle}>{formatMomentDate(m.when)}</Text>
                  {m.where ? <Text style={[styles.tag, { alignSelf: 'flex-start', marginTop: 4 }]}>{labelFor(MOMENT_WHERE, m.where)}</Text> : null}
                </View>
                <Pressable onPress={() => removeMoment(m)} style={styles.removeBtn} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }} accessibilityRole="button" accessibilityLabel={`Delete the moment from ${formatMomentDate(m.when)}`}>
                  <Text style={styles.removeBtnText}>×</Text>
                </Pressable>
              </View>
              {m.around && m.around.length ? (
                <Text style={[styles.bodySmall, { marginTop: 8 }]}>Around it: {m.around.map(a => labelFor(MOMENT_AROUND, a).toLowerCase()).join(', ')}</Text>
              ) : null}
              {m.helped && m.helped.length ? (
                <Text style={styles.bodySmall}>What helped: {m.helped.map(h => labelFor(MOMENT_HELPED, h).toLowerCase()).join(', ')}</Text>
              ) : null}
              {m.note ? <Text style={[styles.body, { marginTop: 8 }]}>{m.note}</Text> : null}
            </Card>
          ))}
        </>
      )}
      <Text style={styles.disclaimer}>Moments stay on this device. Sharing a summary sends it through your own apps — NeuroNest never sees or stores what you send.</Text>
    </ScrollView>
  );
}

function LinksScreen() {
  const { C, styles } = useTheme();
  const tone = { coral: C.coralLight, blue: C.blueLight, purple: C.purpleLight, warm: C.warmLight, nest: C.nestLight };
  const open = (url) => Linking.openURL(url).catch(() => Alert.alert('Could not open link', `You can visit it directly at:\n\n${url}`));
  const call = (num) => Linking.openURL(`tel:${num}`).catch(() => Alert.alert('Could not start call', `You can dial ${num} directly.`));
  return (
    <ScrollView contentContainerStyle={styles.scroll}>
      <Header title="Useful links" subtitle="Everything in one place, for when you need it" />
      {LINK_GROUPS.map(g => (
        <Card key={g.id} style={{ backgroundColor: tone[g.tone], borderWidth: 0 }}>
          <Text style={styles.sectionTitle}>{g.title}</Text>
          {g.intro ? <Text style={[styles.bodySmall, { marginTop: 2 }]}>{g.intro}</Text> : null}
          {g.items.map(item => (
            <View key={item.name} style={styles.linkRow}>
              <Pressable
                onPress={() => open(item.url)}
                style={{ flex: 1 }}
                accessibilityRole="link"
                accessibilityLabel={`${item.name}. ${item.detail}. Opens in your browser.`}
              >
                <Text style={styles.linkName}>{item.name}  ↗</Text>
                <Text style={styles.smallMuted}>{item.detail}</Text>
              </Pressable>
              {item.tel ? (
                <Pressable
                  onPress={() => call(item.tel)}
                  style={styles.callBtn}
                  hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
                  accessibilityRole="button"
                  accessibilityLabel={`Call ${item.name}`}
                >
                  <Text style={styles.callBtnText}>Call</Text>
                </Pressable>
              ) : null}
            </View>
          ))}
        </Card>
      ))}
      <Text style={[styles.smallMuted, { marginTop: 4 }]}>Links and phone numbers checked {CONTENT_REVIEW.support.reviewed}. Organisations change their websites and numbers — if something does not work, search for the organisation by name.</Text>
      <Text style={styles.disclaimer}>These are independent organisations, not part of NeuroNest. We link to them because families find them useful; we are not responsible for their content or services.</Text>
    </ScrollView>
  );
}

function SupportScreen({ go }) {
  const { C, styles } = useTheme();
  const [openTopic, setOpenTopic] = useState(null);
  const tints = [C.nestLight, C.blueLight, C.coralLight, C.purpleLight, C.warmLight, C.greenLight];

  if (openTopic) {
    const topic = SUPPORT_TOPICS.find(t => t.id === openTopic);
    if (topic) return <SupportDetailScreen topic={topic} onBack={() => setOpenTopic(null)} />;
  }

  if (SUPPORT_TOPICS.length === 0) {
    return <ScrollView contentContainerStyle={styles.scroll}><Header title="Quick support" subtitle="Practical information when you need it" /><Card><Text style={styles.bodySmall}>No support resources to show yet. Check back soon.</Text></Card></ScrollView>;
  }

  return (
    <ScrollView contentContainerStyle={styles.scroll}>
      <Header title="Quick support" subtitle="Practical information when you need it" />
      <Pressable onPress={() => go('links')} style={[styles.supportRow, { backgroundColor: C.nestLight, borderColor: C.nestLight }]} accessibilityRole="button" accessibilityLabel="Useful links: helplines, charities and official guidance">
        <View style={[styles.supportIcon, { backgroundColor: C.card }]}><Text>★</Text></View>
        <View style={{ flex: 1 }}>
          <Text style={styles.sectionTitle}>Useful links</Text>
          <Text style={styles.bodySmall}>Helplines, charities and official guidance →</Text>
        </View>
      </Pressable>
      {SUPPORT_TOPICS.map((t, i) => (
        <Pressable key={t.id} onPress={() => setOpenTopic(t.id)} style={styles.supportRow} accessibilityRole="button" accessibilityLabel={t.title}>
          <View style={[styles.supportIcon, { backgroundColor: tints[i % tints.length] }]}><Text>{t.icon}</Text></View>
          <View style={{ flex: 1 }}>
            <Text style={styles.sectionTitle}>{t.title}</Text>
            <Text style={styles.bodySmall}>Open practical guidance</Text>
          </View>
        </Pressable>
      ))}
    </ScrollView>
  );
}

const DEFAULT_ROUTINE_ITEMS = [
  ['Morning routine', true], ['School bag', false], ['After-school reset', false], ['Bedtime routine', false],
];

// Shared between Home's check-in picker and Nest's wellbeing summary so the
// emoji shown for a mood never drifts out of sync between the two screens.
const MOOD_OPTIONS = [
  ['Good', '🙂'],
  ['Okay', '😐'],
  ['Struggling', '🫶'],
];

// Small, fixed-size values → SecureStore. These are comfortably under the
// 2048-byte limit and will stay that way (a boolean, a screen name, an
// index), so a silent size failure isn't a realistic risk here.
function usePersisted(key, value, ready, onError, onSuccess) {
  useEffect(() => {
    if (!ready) return;
    let cancelled = false;
    SecureStore.setItemAsync(key, JSON.stringify(value))
      .then(() => { if (!cancelled) onSuccess(key); })
      .catch(() => { if (!cancelled) onError(key); });
    return () => { cancelled = true; };
  }, [key, value, ready, onError, onSuccess]);
}

// Growing collections → file storage, with failures REPORTED rather than
// swallowed. A parent who writes down a SENCO's email needs to know if it
// didn't save; silently losing it is worse than any error message.
function usePersistedFile(name, value, ready, onError, onSuccess) {
  useEffect(() => {
    if (!ready) return;
    let cancelled = false;
    writeFile(name, JSON.stringify(value))
      .then(() => { if (!cancelled) onSuccess(name); })
      .catch(() => { if (!cancelled) onError(name); });
    return () => { cancelled = true; };
  }, [name, value, ready, onError, onSuccess]);
}

function AppInner() {
  const [screen, setScreen] = useState('home');
  const [isHydrated, setIsHydrated] = useState(false);
  const [mood, setMood] = useState(null);
  const [routineItems, setRoutineItems] = useState(DEFAULT_ROUTINE_ITEMS);
  const [isDark, setIsDark] = useState(false);
  const [hasSeenIntro, setHasSeenIntro] = useState(false);
  const [care, setCare] = useState(null);
  const [mobility, setMobility] = useState(null);
  const [places, setPlaces] = useState([]);
  const [notes, setNotes] = useState([]);
  const [cards, setCards] = useState([]);
  const [moments, setMoments] = useState([]);
  // Set if a write fails, so the user is told rather than quietly losing data.
  // Tracks which files are currently failing to save. A file that later
  // saves successfully removes itself, so a one-off hiccup no longer leaves
  // a permanent warning the user learns to ignore.
  const [failingSaves, setFailingSaves] = useState([]);
  const saveError = failingSaves.length > 0;
  const handleSaveError = React.useCallback(
    name => setFailingSaves(f => (f.includes(name) ? f : [...f, name])), []);
  const handleSaveSuccess = React.useCallback(
    name => setFailingSaves(f => (f.includes(name) ? f.filter(x => x !== name) : f)), []);

  // Load persisted state once on startup. Baseline defaults above are used
  // as-is if nothing is saved yet, or if persistence fails for any reason.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const results = await Promise.allSettled([
          SecureStore.getItemAsync(STORAGE_KEYS.wellbeing),
          SecureStore.getItemAsync(STORAGE_KEYS.theme),
          SecureStore.getItemAsync(STORAGE_KEYS.intro),
          SecureStore.getItemAsync(STORAGE_KEYS.lastScreen),
          SecureStore.getItemAsync(STORAGE_KEYS.care),
          SecureStore.getItemAsync(STORAGE_KEYS.mobility),
          // Growing collections: try the file first, then fall back to the
          // old SecureStore location so data saved by an earlier version is
          // not lost. Anything found in the old location is migrated below.
          readFile(FILE_KEYS.routine),
          readFile(FILE_KEYS.places),
          readFile(FILE_KEYS.notes),
          readFile(FILE_KEYS.cards),
          readFile(FILE_KEYS.moments),
          SecureStore.getItemAsync(LEGACY_SECURE_KEYS.routine),
          SecureStore.getItemAsync(LEGACY_SECURE_KEYS.places),
          SecureStore.getItemAsync(LEGACY_SECURE_KEYS.notes),
        ]);
        // Each key is independent: a failure reading one (corrupted value,
        // one-off storage error) no longer blocks restoring the others —
        // that key just falls back to its baseline default on its own.
        const value = r => (r.status === 'fulfilled' ? r.value : null);
        const [
          savedWellbeing, savedTheme, savedIntro, savedScreen, savedCare, savedMobility,
          fileRoutine, filePlaces, fileNotes, fileCards, fileMoments,
          legacyRoutine, legacyPlaces, legacyNotes,
        ] = results.map(value);
        if (cancelled) return;

        // Choosing between the file and the pre-v1.10 SecureStore copy is a
        // THREE-way decision, not two: a file can be missing, valid, or
        // present-but-corrupt. Branching only on "does the file exist" meant
        // a corrupt new file beat a perfectly good legacy copy, stranding
        // real user data that was still sitting there intact.
        const isUsable = raw => {
          if (raw === null) return false;
          try {
            const parsed = JSON.parse(raw);
            return Array.isArray(parsed);
          } catch (e) {
            return false;
          }
        };
        // Prefer a usable file; otherwise fall back to the legacy copy.
        const pick = (file, legacy) => (isUsable(file) ? file : (isUsable(legacy) ? legacy : file));
        const savedRoutine = pick(fileRoutine, legacyRoutine);
        const savedPlaces = pick(filePlaces, legacyPlaces);
        const savedNotes = pick(fileNotes, legacyNotes);
        // Migrate whenever the legacy copy is the one we are actually using —
        // whether the file was absent or unreadable. The old copy is only
        // cleared after the new file has been written successfully.
        const migrations = [];
        if (!isUsable(fileRoutine) && isUsable(legacyRoutine)) migrations.push([FILE_KEYS.routine, legacyRoutine, LEGACY_SECURE_KEYS.routine]);
        if (!isUsable(filePlaces) && isUsable(legacyPlaces)) migrations.push([FILE_KEYS.places, legacyPlaces, LEGACY_SECURE_KEYS.places]);
        if (!isUsable(fileNotes) && isUsable(legacyNotes)) migrations.push([FILE_KEYS.notes, legacyNotes, LEGACY_SECURE_KEYS.notes]);
        for (const [file, contents, oldKey] of migrations) {
          try {
            await writeFile(file, contents);
            await SecureStore.deleteItemAsync(oldKey);
          } catch (e) { /* migration retried next launch; old copy left intact */ }
        }
        if (savedWellbeing !== null) {
          try { setMood(JSON.parse(savedWellbeing)); } catch (e) { /* ignore malformed value, keep default */ }
        }
        if (savedRoutine !== null) {
          try {
            const parsed = JSON.parse(savedRoutine);
            const isValidItem = x => Array.isArray(x) && x.length === 2
              && typeof x[0] === 'string' && x[0].length > 0 && x[0].length <= FIELD_LIMITS.routineItem
              && typeof x[1] === 'boolean';
            // An empty array is a deliberate choice (the user cleared their
            // list), NOT an absence of data — restoring the defaults over it
            // would silently undo their deletion every time they reopen.
            // Invalid entries are dropped individually rather than discarding
            // the whole list, so one corrupted row can't wipe good ones.
            if (Array.isArray(parsed)) setRoutineItems(parsed.filter(isValidItem));
          } catch (e) { /* ignore malformed value, keep default */ }
        }
        if (savedTheme !== null) {
          try { setIsDark(JSON.parse(savedTheme) === true); } catch (e) { /* ignore malformed value, keep default */ }
        }
        if (savedIntro !== null) {
          try { setHasSeenIntro(JSON.parse(savedIntro) === true); } catch (e) { /* ignore malformed value, keep default */ }
        }
        // Kids Mode is never restored into directly (see the save-side note
        // below) — an unrecognized or 'kids' value is ignored, keeping 'home'.
        const validScreens = ['home', 'nest', 'settings', 'sos', 'benefits', 'plan', 'discover', 'support', 'notes', 'links', 'cards', 'moments'];
        if (savedScreen !== null) {
          try {
            const parsed = JSON.parse(savedScreen);
            if (validScreens.includes(parsed)) setScreen(parsed);
          } catch (e) { /* ignore malformed value, keep default */ }
        }
        if (savedCare !== null) {
          try {
            const n = JSON.parse(savedCare);
            if (Number.isInteger(n) && n >= 0 && n < DLA.care.length) setCare(n);
          } catch (e) { /* ignore malformed value, keep default */ }
        }
        if (savedMobility !== null) {
          try {
            const n = JSON.parse(savedMobility);
            if (Number.isInteger(n) && n >= 0 && n < DLA.mobility.length) setMobility(n);
          } catch (e) { /* ignore malformed value, keep default */ }
        }
        if (savedPlaces !== null) {
          try {
            const parsed = JSON.parse(savedPlaces);
            const validTagIds = PLACE_TAGS.map(t => t[0]);
            const validVerdicts = VERDICTS.map(v => v[0]);
            const isValidPlace = p => p
              && typeof p.id === 'string' && p.id.length > 0
              && typeof p.name === 'string' && p.name.length > 0 && p.name.length <= FIELD_LIMITS.placeName
              && (p.note === undefined || (typeof p.note === 'string' && p.note.length <= FIELD_LIMITS.placeNote))
              && validVerdicts.includes(p.verdict)
              && Array.isArray(p.tags) && p.tags.every(t => validTagIds.includes(t));
            if (Array.isArray(parsed)) setPlaces(parsed.filter(isValidPlace));
          } catch (e) { /* ignore malformed value, keep default */ }
        }
        if (fileCards !== null) {
          try {
            const parsed = JSON.parse(fileCards);
            const isValidCard = k => k && typeof k.id === 'string' && k.id.length > 0
              && typeof k.title === 'string' && k.title.length > 0 && k.title.length <= FIELD_LIMITS.cardTitle
              && (k.who === undefined || (typeof k.who === 'string' && k.who.length <= FIELD_LIMITS.cardWho))
              && Array.isArray(k.lines) && k.lines.length > 0
              && k.lines.every(l => typeof l === 'string' && l.length > 0 && l.length <= FIELD_LIMITS.cardLine);
            if (Array.isArray(parsed)) setCards(parsed.filter(isValidCard));
          } catch (e) { /* ignore malformed value, keep default */ }
        }
        if (fileMoments !== null) {
          try {
            const parsed = JSON.parse(fileMoments);
            const okList = (v, src) => v === undefined || (Array.isArray(v) && v.every(x => typeof x === 'string' && src.some(s => s[0] === x)));
            const isValidMoment = m => m && typeof m.id === 'string' && m.id.length > 0
              && typeof m.when === 'number' && Number.isFinite(m.when) && m.when > 0
              && (m.where === null || m.where === undefined || MOMENT_WHERE.some(w => w[0] === m.where))
              && okList(m.around, MOMENT_AROUND) && okList(m.helped, MOMENT_HELPED)
              && (m.note === undefined || (typeof m.note === 'string' && m.note.length <= FIELD_LIMITS.momentNote));
            if (Array.isArray(parsed)) setMoments(parsed.filter(isValidMoment));
          } catch (e) { /* ignore malformed value, keep default */ }
        }
        if (savedNotes !== null) {
          try {
            const parsed = JSON.parse(savedNotes);
            const isValidNote = n => n && typeof n.id === 'string' && n.id.length > 0
              && typeof n.text === 'string' && n.text.length > 0 && n.text.length <= FIELD_LIMITS.noteText;
            if (Array.isArray(parsed)) setNotes(parsed.filter(isValidNote));
          } catch (e) { /* ignore malformed value, keep default */ }
        }
      } catch (e) {
        // Persistence unavailable — fail safe and continue with baseline defaults.
      } finally {
        if (!cancelled) setIsHydrated(true);
      }
    })();
    return () => { cancelled = true; };
  }, []);

  // Save on change — guarded by isHydrated so we never overwrite a saved
  // value with the pre-load default, and never write before load completes.
  // One persisted value per line. Each writes to SecureStore whenever it
  // changes, but never before hydration finishes — otherwise the baseline
  // defaults would overwrite the user's saved data on every launch.
  usePersisted(STORAGE_KEYS.wellbeing, mood, isHydrated, handleSaveError, handleSaveSuccess);
  usePersisted(STORAGE_KEYS.theme, isDark, isHydrated, handleSaveError, handleSaveSuccess);
  usePersisted(STORAGE_KEYS.intro, hasSeenIntro, isHydrated, handleSaveError, handleSaveSuccess);
  usePersisted(STORAGE_KEYS.care, care, isHydrated, handleSaveError, handleSaveSuccess);
  usePersisted(STORAGE_KEYS.mobility, mobility, isHydrated, handleSaveError, handleSaveSuccess);

  usePersistedFile(FILE_KEYS.routine, routineItems, isHydrated, handleSaveError, handleSaveSuccess);
  usePersistedFile(FILE_KEYS.places, places, isHydrated, handleSaveError, handleSaveSuccess);
  usePersistedFile(FILE_KEYS.notes, notes, isHydrated, handleSaveError, handleSaveSuccess);
  usePersistedFile(FILE_KEYS.cards, cards, isHydrated, handleSaveError, handleSaveSuccess);
  usePersistedFile(FILE_KEYS.moments, moments, isHydrated, handleSaveError, handleSaveSuccess);

  // Kids Mode is deliberately excluded — reopening the app should never
  // silently drop back into a screen with the bottom nav hidden. Hence the
  // extra guard rather than a plain usePersisted call.
  usePersisted(STORAGE_KEYS.lastScreen, screen, isHydrated && screen !== 'kids');

  const go = setScreen;

  const resetAppData = async () => {
    // Every deletion is tracked individually. Reset is the control a parent
    // uses before handing a device on, so it must report what actually
    // happened rather than announcing success regardless.
    const results = await Promise.allSettled([
      SecureStore.deleteItemAsync(STORAGE_KEYS.wellbeing),
      SecureStore.deleteItemAsync(STORAGE_KEYS.theme),
      SecureStore.deleteItemAsync(STORAGE_KEYS.intro),
      SecureStore.deleteItemAsync(STORAGE_KEYS.lastScreen),
      SecureStore.deleteItemAsync(STORAGE_KEYS.care),
      SecureStore.deleteItemAsync(STORAGE_KEYS.mobility),
      deleteFile(FILE_KEYS.routine),
      deleteFile(FILE_KEYS.places),
      deleteFile(FILE_KEYS.notes),
      deleteFile(FILE_KEYS.cards),
      deleteFile(FILE_KEYS.moments),
      SecureStore.deleteItemAsync(LEGACY_SECURE_KEYS.routine),
      SecureStore.deleteItemAsync(LEGACY_SECURE_KEYS.places),
      SecureStore.deleteItemAsync(LEGACY_SECURE_KEYS.notes),
    ]);
    const failed = results.filter(r => r.status === 'rejected').length;
    {
      // Best-effort — even if the stored copies can't be cleared, resetting
      // in-memory state below still gives the user a fresh-feeling app now.
      //
      // NOTE ON A DELIBERATE NON-FIX: an audit flagged that the state reset
      // below immediately re-persists, so the files are recreated containing
      // the cleared values rather than staying absent. A "suppress writes
      // while resetting" flag was tried and REVERTED: React batches the
      // state reset and the flag-clear into a single update, so the effects
      // still see ready=true alongside the cleared values and write anyway.
      // The flag suppressed writes only during the delete window, when
      // nothing changes — a no-op wearing a confident comment.
      // The end state is correct either way (empty collections, default
      // routine), so this is recorded as accepted behaviour rather than
      // papered over with a guard that does not guard.
    }
    setMood(null);
    setRoutineItems(DEFAULT_ROUTINE_ITEMS);
    setIsDark(false);
    setHasSeenIntro(false);
    setCare(null);
    setMobility(null);
    setPlaces([]);
    setNotes([]);
    setCards([]);
    setMoments([]);
    setFailingSaves([]);
    setScreen('home');
    if (failed > 0) {
      Alert.alert(
        'Reset partly finished',
        'NeuroNest has been cleared on screen, but this device would not let go of everything. Some information may still be stored.\n\nIf you are passing this device on, uninstalling the app as well is the safest option.'
      );
    } else {
      Alert.alert('Reset complete', 'Everything NeuroNest had saved on this device has been deleted.');
    }
  };

  const theme = useMemo(
    () => ({ C: isDark ? DARK : LIGHT, styles: makeStyles(isDark ? DARK : LIGHT), isDark }),
    [isDark]
  );

  // Hold a blank, background-matched frame during hydration rather than
  // rendering baseline defaults that would then visibly flash to the
  // restored values a moment later.
  if (!isHydrated) {
    return (
      <ThemeContext.Provider value={theme}>
        <SafeAreaView style={[styles.app, isDark && styles.appDark]}>
          <StatusBar barStyle={isDark ? 'light-content' : 'dark-content'} backgroundColor={isDark ? DARK.bg : C.bg} />
        </SafeAreaView>
      </ThemeContext.Provider>
    );
  }

  const screenMap = {
    home: <HomeScreen go={go} mood={mood} setMood={setMood} items={routineItems} />,
    nest: <NestScreen mood={mood} items={routineItems} go={go} notes={notes} places={places} cards={cards} moments={moments} />,
    notes: <NotesScreen notes={notes} setNotes={setNotes} go={go} />,
    cards: <CardsScreen cards={cards} setCards={setCards} go={go} />,
    moments: <MomentsScreen moments={moments} setMoments={setMoments} go={go} />,
    settings: <SettingsScreen isDark={isDark} onToggleTheme={() => setIsDark(d => !d)} onResetData={resetAppData} />,
    sos: <SOSScreen />,
    kids: <KidsScreen go={go} />,
    benefits: <BenefitsScreen care={care} setCare={setCare} mobility={mobility} setMobility={setMobility} />,
    plan: <PlanScreen items={routineItems} setItems={setRoutineItems} />,
    discover: <DiscoverScreen places={places} setPlaces={setPlaces} />,
    support: <SupportScreen go={go} />,
    links: <LinksScreen />,
  };
  return (
    <ThemeContext.Provider value={theme}>
      <SafeAreaView style={[styles.app, isDark && styles.appDark]}>
        <StatusBar barStyle={isDark ? 'light-content' : 'dark-content'} backgroundColor={isDark ? DARK.bg : C.bg} />
        <View style={{ flex: 1 }}>{screenMap[screen] || screenMap.home}</View>
        {saveError && screen !== 'kids' ? (
          <Pressable
            onPress={() => Alert.alert(
              'Some changes may not be saved',
              'NeuroNest could not write to this device\u2019s storage. Recent changes may be lost if you close the app.\n\nIf this keeps happening, check your device has free storage space.',
              [{ text: 'OK' }, { text: 'Dismiss warning', onPress: () => setFailingSaves([]) }]
            )}
            style={theme.styles.saveErrorBar}
            accessibilityRole="button"
            accessibilityLiveRegion="assertive"
            accessibilityLabel="Warning: some changes may not be saved. Tap for details."
          >
            <Text style={theme.styles.saveErrorText}>⚠  Some changes may not be saved — tap for details</Text>
          </Pressable>
        ) : null}
        {screen !== 'kids' && <View style={[styles.nav, isDark && styles.navDark]}>
          <NavItem label="Home" icon="⌂" active={screen === 'home'} onPress={() => go('home')} isDark={isDark} />
          <NavItem label="Plan" icon="✓" active={screen === 'plan'} onPress={() => go('plan')} isDark={isDark} />
          <NavItem label="Help" icon="?" active={screen === 'support' || screen === 'sos'} onPress={() => go('support')} isDark={isDark} />
          <NavItem label="Discover" icon="⌖" active={screen === 'discover'} onPress={() => go('discover')} isDark={isDark} />
          <NavItem label="Nest" icon="♡" active={screen === 'nest'} onPress={() => go('nest')} isDark={isDark} />
        </View>}
        <Modal visible={!hasSeenIntro} transparent animationType="fade" onRequestClose={() => setHasSeenIntro(true)}>
          <View style={theme.styles.modalBackdrop} accessibilityViewIsModal={true}><View style={theme.styles.passModal}>
            <Text style={theme.styles.kicker}>Welcome</Text>
            <Text style={theme.styles.bigTitle}>A safe place for neurodivergent families</Text>
            <Text style={theme.styles.body}>NeuroNest brings routines, wellbeing check-ins, and calm support for your child into one place. You can always find help under "Help" if things feel like too much.</Text>
            <Pressable onPress={() => setHasSeenIntro(true)} style={theme.styles.primaryBtn} accessibilityRole="button" accessibilityLabel="Get started">
              <Text style={theme.styles.primaryText}>Get started</Text>
            </Pressable>
          </View></View>
        </Modal>
      </SafeAreaView>
    </ThemeContext.Provider>
  );
}

function NavItem({ label, icon, active, onPress, isDark }) { return <Pressable onPress={onPress} style={styles.navItem} accessibilityRole="button" accessibilityLabel={label} accessibilityState={{ selected: active }}><Text style={[styles.navIcon, isDark && styles.navIconDark, active && styles.navActive]}>{icon}</Text><Text style={[styles.navText, isDark && styles.navIconDark, active && styles.navActive]}>{label}</Text></Pressable>; }

const makeStyles = (C) => StyleSheet.create({
  app:{flex:1,backgroundColor:C.bg},
  scroll:{padding:20,paddingBottom:110},
  header:{flexDirection:'row',alignItems:'center',marginBottom:24},
  logoCircle:{width:44,height:44,borderRadius:26,backgroundColor:C.nestLight,alignItems:'center',justifyContent:'center',marginRight:12},
  brandLogo:{width:84,height:40,marginRight:12},
  logo:{fontSize:20,color:C.nestText}, brand:{fontSize:20,fontWeight:'800',color:C.ink}, headerSub:{fontSize:12,color:C.muted,marginTop:4},
  greeting:{fontSize:26,fontWeight:'800',color:C.ink}, body:{fontSize:16,lineHeight:22,color:C.muted}, bodySmall:{fontSize:14,lineHeight:19,color:C.muted},
  card:{backgroundColor:C.card,borderWidth:1,borderColor:C.border,borderRadius:18,padding:16,marginBottom:16},
  checkCard:{marginTop:20}, sectionTitle:{fontSize:16,fontWeight:'750',color:C.ink}, smallMuted:{fontSize:12,color:C.muted}, sectionRow:{flexDirection:'row',justifyContent:'space-between',alignItems:'center',marginTop:8,marginBottom:8},
  rowGap:{flexDirection:'row',gap:8,marginTop:16}, mood:{flex:1,borderWidth:1,borderColor:C.border,borderRadius:14,paddingVertical:12,alignItems:'center'}, moodSelected:{borderColor:C.nest,backgroundColor:C.nestLight}, moodEmoji:{fontSize:20}, moodText:{fontSize:12,color:C.ink,marginTop:4},
  sosButton:{backgroundColor:C.coralLight,borderRadius:18,padding:16,flexDirection:'row',alignItems:'center',marginBottom:24}, sosIcon:{fontSize:20,color:C.coralText,marginRight:12}, sosTitle:{fontSize:14,fontWeight:'900',color:C.coralText}, sosSub:{fontSize:12,color:C.ink,marginTop:4}, arrow:{fontSize:26,color:C.coralText},
  taskRow:{flexDirection:'row',alignItems:'center',paddingVertical:12,gap:12}, check:{width:25,height:25,borderRadius:8,borderWidth:1.5,borderColor:C.border,alignItems:'center',justifyContent:'center'}, checkDone:{backgroundColor:C.nest,borderColor:C.nest}, checkMark:{color:C.onNest,fontWeight:'900'}, taskTitle:{fontSize:14,color:C.ink,fontWeight:'600'}, taskDone:{textDecorationLine:'line-through',color:C.muted}, cardLink:{borderTopWidth:1,borderTopColor:C.border,paddingTop:12,marginTop:4}, cardLinkText:{color:C.nestText,fontWeight:'700'},
  quickGrid:{flexDirection:'row',flexWrap:'wrap',gap:8,marginBottom:16}, quick:{width:'48%',borderRadius:18,padding:16}, quickIcon:{fontSize:20,color:C.ink,marginBottom:8}, quickText:{fontSize:14,fontWeight:'750',color:C.ink},
  nestCard:{backgroundColor:C.nestLight,borderColor:C.nestLight}, nestItems:{marginTop:12,gap:8}, nestItem:{flexDirection:'row',alignItems:'center',gap:8}, dot:{fontSize:20,color:C.nestText}, nestText:{color:C.ink,fontSize:14},
  sosHero:{backgroundColor:C.coralLight,borderRadius:26,padding:20,marginBottom:16}, sosHeroIcon:{fontSize:26,color:C.coralText}, sosHeroTitle:{fontSize:20,fontWeight:'850',color:C.ink,marginTop:8}, sosHeroBody:{fontSize:14,lineHeight:21,color:C.muted,marginTop:4}, kicker:{fontSize:11,fontWeight:'800',color:C.nestText}, bigTitle:{fontSize:26,fontWeight:'850',color:C.ink,marginVertical:8}, progressRow:{flexDirection:'row',gap:4,marginTop:20,marginBottom:16}, progressDot:{height:5,flex:1,borderRadius:8,backgroundColor:C.border}, progressDotActive:{backgroundColor:C.nest},
  primaryBtn:{flex:1,backgroundColor:C.nest,borderRadius:14,padding:12,alignItems:'center',justifyContent:'center'}, primaryText:{color:C.onNest,fontWeight:'800'}, secondaryBtn:{flex:1,borderWidth:1,borderColor:C.border,borderRadius:14,padding:12,alignItems:'center'}, secondaryText:{color:C.ink,fontWeight:'700'}, disabled:{opacity:.4}, passButton:{backgroundColor:C.blueLight,borderRadius:18,padding:16,marginBottom:8}, passTitle:{fontSize:16,fontWeight:'800',color:C.blueText}, passSub:{fontSize:12,color:C.muted,marginTop:4}, outlineBtn:{borderWidth:1,borderColor:C.border,borderRadius:14,padding:12,alignItems:'center',marginTop:8}, outlineText:{fontWeight:'700',color:C.ink},
  modalBackdrop:{flex:1,backgroundColor:'rgba(20,30,30,.45)',alignItems:'center',justifyContent:'center',padding:20}, passModal:{backgroundColor:C.card,borderRadius:26,padding:24,width:'100%',maxWidth:430}, passModalBody:{fontSize:16,lineHeight:23,color:C.muted,marginVertical:12}, passRule:{backgroundColor:C.warmLight,borderRadius:14,padding:16,marginBottom:16}, passRuleText:{fontWeight:'700',color:C.ink},
  kidsWrap:{flex:1,backgroundColor:C.bg,padding:20}, kidsTop:{flexDirection:'row',justifyContent:'space-between',alignItems:'center',marginBottom:16}, kidsTitle:{fontSize:26,fontWeight:'900',color:C.ink}, kidsSub:{color:C.muted}, exitText:{fontWeight:'800',color:C.muted}, glow:{height:430,borderRadius:26,backgroundColor:C.nestLight,overflow:'hidden',position:'relative',alignItems:'center',justifyContent:'center'}, glowHint:{color:C.muted}, glowPoint:{position:'absolute',width:36,height:36,borderRadius:18,backgroundColor:C.warm}, timerCard:{backgroundColor:C.card,borderRadius:26,padding:16,marginTop:16}, timerLabel:{fontSize:11,fontWeight:'800',color:C.muted}, timer:{fontSize:40,fontWeight:'900',color:C.ink,marginVertical:4}, timerTrack:{height:9,borderRadius:8,backgroundColor:C.border,overflow:'hidden'}, timerFill:{height:9,backgroundColor:C.nest}, kidsBtn:{flex:1,backgroundColor:C.nest,borderRadius:14,padding:12,alignItems:'center'}, kidsBtnText:{color:C.onNest,fontWeight:'800'}, kidsBtnSecondary:{padding:12,borderWidth:1,borderColor:C.border,borderRadius:14,alignItems:'center'}, kidsBtnSecondaryText:{fontWeight:'700',color:C.ink},
  infoCard:{backgroundColor:C.blueLight,borderColor:C.blueLight}, choiceWrap:{flexDirection:'row',flexWrap:'wrap',gap:8,marginTop:12}, pill:{borderWidth:1,borderColor:C.border,borderRadius:26,paddingVertical:8,paddingHorizontal:12}, pillActive:{backgroundColor:C.nestLight,borderColor:C.nest}, pillText:{fontSize:12,color:C.ink}, pillTextActive:{color:C.nestText,fontWeight:'800'}, totalCard:{backgroundColor:C.nestLight,borderColor:C.nestLight}, total:{fontSize:26,fontWeight:'900',color:C.ink,marginTop:4}, resourceRow:{flexDirection:'row',alignItems:'center',marginTop:8}, disclaimer:{fontSize:11,lineHeight:16,color:C.muted,marginTop:16},
  firstThen:{flexDirection:'row',alignItems:'center',gap:8,marginTop:12}, firstBox:{flex:1,backgroundColor:C.blueLight,padding:12,borderRadius:14,color:C.ink,fontWeight:'700'}, thenBox:{flex:1,backgroundColor:C.greenLight,padding:12,borderRadius:14,color:C.ink,fontWeight:'700'}, thenArrow:{fontSize:20,color:C.muted}, tagRow:{flexDirection:'row',flexWrap:'wrap',gap:8,marginTop:12}, tag:{fontSize:11,color:C.nestText,backgroundColor:C.nestLight,paddingVertical:4,paddingHorizontal:8,borderRadius:8}, supportRow:{backgroundColor:C.card,borderWidth:1,borderColor:C.border,borderRadius:18,padding:16,marginBottom:8,flexDirection:'row',alignItems:'center',gap:12}, supportIcon:{width:42,height:42,borderRadius:14,alignItems:'center',justifyContent:'center'},
  nav:{position:'absolute',left:12,right:12,bottom:12,height:68,borderRadius:26,backgroundColor:C.card,borderWidth:1,borderColor:C.border,flexDirection:'row',alignItems:'center',justifyContent:'space-around',shadowOpacity:.08,shadowRadius:12,shadowOffset:{width:0,height:3}}, navItem:{alignItems:'center',justifyContent:'center',minWidth:52}, navIcon:{fontSize:20,color:C.muted}, navText:{fontSize:11,color:C.muted,marginTop:4}, navActive:{color:C.nestText,fontWeight:'900'},
  // NN-001 theme toggle additions (app chrome only, see C_DARK above)
  appDark:{backgroundColor:DARK.bg},
  navDark:{backgroundColor:DARK.card,borderColor:DARK.border},
  navIconDark:{color:DARK.muted},
  themeToggle:{width:44,height:44,borderRadius:26,alignItems:'center',justifyContent:'center',backgroundColor:C.nestLight,marginLeft:8},
  themeToggleIcon:{fontSize:16,color:C.nest},
  // Task 2: Kids Mode hold-to-exit progress fill
  holdFill:{position:'absolute',left:0,top:0,bottom:0,backgroundColor:'rgba(255,255,255,0.35)'},
  // Task 2: editable routine list controls
  removeBtn:{width:28,height:28,borderRadius:14,alignItems:'center',justifyContent:'center',marginLeft:8}, removeBtnText:{fontSize:16,color:C.muted,fontWeight:'700'},
  editBtn:{width:28,height:28,borderRadius:14,alignItems:'center',justifyContent:'center',marginLeft:4}, editBtnText:{fontSize:14,color:C.muted},
  errorText:{fontSize:12,color:C.coralText,marginTop:8},
  linkRow:{flexDirection:'row',alignItems:'center',paddingVertical:8,gap:8},
  linkName:{fontSize:14,fontWeight:'700',color:C.ink},
  callBtn:{paddingVertical:8,paddingHorizontal:16,borderRadius:18,borderWidth:1,borderColor:C.nest},
  callBtnText:{fontSize:12,fontWeight:'800',color:C.nestText},
  saveErrorBar:{backgroundColor:C.coralLight,paddingVertical:8,paddingHorizontal:16,marginHorizontal:12,borderRadius:14,marginBottom:4},
  saveErrorText:{fontSize:12,color:C.coralText,fontWeight:'700',textAlign:'center'},
  addRow:{flexDirection:'row',alignItems:'center',marginTop:8,gap:8}, addInput:{flex:1,borderWidth:1,borderColor:C.border,borderRadius:14,paddingHorizontal:12,paddingVertical:8,color:C.ink,fontSize:14}, fieldInput:{alignSelf:'stretch',borderWidth:1,borderColor:C.border,borderRadius:14,paddingHorizontal:12,paddingVertical:8,color:C.ink,fontSize:14}, addBtn:{backgroundColor:C.nest,borderRadius:14,paddingHorizontal:16,paddingVertical:8}, addBtnText:{color:C.onNest,fontWeight:'800'},
  // Task 5: Settings screen
  settingsRow:{flexDirection:'row',alignItems:'center',justifyContent:'space-between'},
});

// Module-level alias, same reasoning as the `C` alias above: SOSScreen
// references `styles` directly and is frozen, so it always gets the LIGHT
// stylesheet. Every other screen pulls its stylesheet from useTheme()
// instead, computed fresh for the active palette.
const styles = makeStyles(LIGHT);

// Task 4: basic error boundary. Purely local/offline — catches an
// unexpected render error anywhere below and shows a calm fallback
// instead of a blank crashed screen. No new dependency.
class ErrorBoundary extends React.Component {
  constructor(props) {
    super(props);
    this.state = { hasError: false };
  }
  static getDerivedStateFromError() {
    return { hasError: true };
  }
  render() {
    if (this.state.hasError) {
      return (
        <SafeAreaView style={[styles.app, { alignItems: 'center', justifyContent: 'center', padding: 24 }]}>
          <Text style={styles.bigTitle}>Something went wrong</Text>
          <Text style={[styles.body, { textAlign: 'center', marginBottom: 20 }]}>
            Sorry about that — nothing you did caused this. Try again, or close and reopen the app if it keeps happening.
          </Text>
          <Pressable onPress={() => this.setState({ hasError: false })} style={styles.primaryBtn} accessibilityRole="button" accessibilityLabel="Try again">
            <Text style={styles.primaryText}>Try again</Text>
          </Pressable>
        </SafeAreaView>
      );
    }
    return this.props.children;
  }
}

export default function App() {
  return (
    <ErrorBoundary>
      <AppInner />
    </ErrorBoundary>
  );
}
