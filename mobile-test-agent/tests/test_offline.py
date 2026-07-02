"""Offline tests: parser + snapshot + matcher + verifier against a
realistic Android page source — no device, no LLM, no network."""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from mobile_test_agent.matcher import resolve, element_score
from mobile_test_agent.parser import Command, parse_step, parse_date_value
from mobile_test_agent.snapshot import parse_page_source
from mobile_test_agent import verify as V

FIXTURE = """<?xml version='1.0' encoding='UTF-8'?>
<hierarchy rotation="0">
  <android.widget.FrameLayout bounds="[0,0][1080,2280]" class="android.widget.FrameLayout" displayed="true">
    <android.widget.TextView text="Welcome to MyBank" class="android.widget.TextView" bounds="[80,200][1000,300]" displayed="true"/>
    <android.widget.Button text="OK Continue" resource-id="com.mybank:id/btn_ok_continue" class="android.widget.Button" clickable="true" enabled="true" bounds="[240,2000][840,2150]" displayed="true"/>
    <android.widget.EditText text="Username" resource-id="com.mybank:id/input_username" class="android.widget.EditText" clickable="true" enabled="true" bounds="[80,500][1000,640]" displayed="true"/>
    <android.widget.EditText text="" resource-id="com.mybank:id/input_pin" password="true" class="android.widget.EditText" clickable="true" enabled="true" bounds="[80,700][1000,840]" displayed="true"/>
    <android.widget.TextView text="Date of Birth" class="android.widget.TextView" bounds="[80,900][500,970]" displayed="true"/>
    <android.widget.EditText text="" resource-id="com.mybank:id/input_dob" class="android.widget.EditText" clickable="true" enabled="true" bounds="[80,980][1000,1120]" displayed="true" hint="DD/MM/YYYY"/>
    <android.widget.Switch text="" resource-id="com.mybank:id/switch_biometric" content-desc="Enable biometric login" checkable="true" checked="false" clickable="true" enabled="true" bounds="[900,1200][1040,1280]" displayed="true"/>
    <androidx.recyclerview.widget.RecyclerView resource-id="com.mybank:id/account_list" scrollable="true" class="androidx.recyclerview.widget.RecyclerView" bounds="[0,1300][1080,1900]" displayed="true">
      <android.widget.LinearLayout clickable="true" class="android.widget.LinearLayout" bounds="[0,1300][1080,1480]" displayed="true">
        <android.widget.TextView text="Savings Account 1238735444" class="android.widget.TextView" bounds="[40,1330][900,1400]" displayed="true"/>
      </android.widget.LinearLayout>
      <android.widget.LinearLayout clickable="true" class="android.widget.LinearLayout" bounds="[0,1480][1080,1660]" displayed="true">
        <android.widget.TextView text="Current Account 9987125630" class="android.widget.TextView" bounds="[40,1510][900,1580]" displayed="true"/>
      </android.widget.LinearLayout>
    </androidx.recyclerview.widget.RecyclerView>
  </android.widget.FrameLayout>
</hierarchy>
"""


def snap():
    return parse_page_source(FIXTURE, "android")


# ------------------------- parser (incl. the user's typos) ----------------

def test_parse_tap():
    cmd = parse_step("Tap ok continue")
    assert cmd.kind == "tap" and cmd.target == "ok continue"


def test_parse_enter_as():
    cmd = parse_step("Enter username as hello")
    assert cmd.kind == "input"
    assert cmd.target == "username" and cmd.value == "hello"
    assert not cmd.secure


def test_parse_typo_verb_and_secure():
    cmd = parse_step("Entet pin as 7807283")   # typo'd verb
    assert cmd.kind == "input"
    assert cmd.target == "pin" and cmd.value == "7807283"
    assert cmd.secure


def test_parse_dob_flags_date():
    cmd = parse_step("Enter date of birth as 01 01 1990")
    assert cmd.kind == "input" and cmd.maybe_date
    assert parse_date_value(cmd.value).isoformat() == "1990-01-01"


def test_parse_tap_on_account():
    cmd = parse_step("Tap on account number 1238735444")
    assert cmd.kind == "tap" and "1238735444" in cmd.target


def test_parse_toggle_select_scroll_assert_wait():
    assert parse_step("Turn on enable biometric login").toggle_state == "on"
    c = parse_step("Select March from month picker")
    assert c.kind == "select" and c.value == "march" and c.target == "month picker"
    assert parse_step("Scroll down").direction == "down"
    assert parse_step("scroll to transactions").target == "transactions"
    assert parse_step("Verify account details is visible").kind == "assert_visible"
    assert parse_step("wait 2 seconds").value == "2.0"
    assert parse_step("press back").kind == "back"


def test_parse_dates_various():
    assert parse_date_value("01/01/1990").isoformat() == "1990-01-01"
    assert parse_date_value("15 Aug 1997").isoformat() == "1997-08-15"
    assert parse_date_value("1990-01-31").isoformat() == "1990-01-31"
    assert parse_date_value("31 12 2000").isoformat() == "2000-12-31"


# ------------------------------- snapshot ------------------------------

def test_snapshot_distills_and_hashes():
    s = snap()
    assert s.screen_size == (1080, 2280)
    assert s.hash and s.hash == snap().hash
    tags = {e.tag for e in s.elements}
    assert "Button" in tags and "EditText" in tags and "Switch" in tags
    listing = s.listing()
    assert "btn_ok_continue" in listing and len(listing) < len(FIXTURE) / 2


# ------------------------------- matcher --------------------------------

def _resolve(text):
    return resolve(parse_step(text), snap())


def test_match_button():
    r = _resolve("Tap ok continue")
    assert r.confident and r.element.res_id_tail == "btn_ok_continue"


def test_match_username_field():
    r = _resolve("Enter username as hello")
    assert r.confident and r.element.res_id_tail == "input_username"
    assert r.element.editable


def test_match_pin_field_by_resource_id():
    r = _resolve("Entet pin as 7807283")
    assert r.confident and r.element.res_id_tail == "input_pin"
    assert r.element.password


def test_match_dob_by_label_and_id():
    r = _resolve("Enter date of birth as 01 01 1990")
    assert r.confident and r.element.res_id_tail == "input_dob"


def test_match_account_by_digit_run():
    r = _resolve("Tap on account number 1238735444")
    assert r.confident
    assert "1238735444" in (r.element.text + r.element.desc)


def test_digit_run_rejects_wrong_account():
    cmd = parse_step("Tap on account number 0000000000")
    r = resolve(cmd, snap())
    assert not r.confident


def test_match_toggle_prefers_checkable():
    r = _resolve("Turn on biometric login")
    assert r.confident and r.element.tag == "Switch"
    assert r.element.checked is False


# ------------------------------- verify ---------------------------------

def test_verify_visible_and_not_visible():
    s = snap()
    ok = V.verify_visible(s, Command(kind="assert_visible",
                                     target="welcome to mybank", raw=""))
    assert ok.ok
    gone = V.verify_visible(s, Command(kind="assert_not_visible",
                                       target="logout", raw=""))
    assert gone.ok


def test_verify_input_secure_nonempty():
    s = snap()
    field = next(e for e in s.elements if e.res_id_tail == "input_pin")
    filled = FIXTURE.replace(
        'resource-id="com.mybank:id/input_pin" password="true"',
        'resource-id="com.mybank:id/input_pin" password="true" text-filled="x"',
    ).replace(
        '<android.widget.EditText text="" resource-id="com.mybank:id/input_pin"',
        '<android.widget.EditText text="•••••••" resource-id="com.mybank:id/input_pin"',
    )
    after = parse_page_source(filled, "android")
    cmd = parse_step("Enter pin as 7807283")
    assert V.verify_input(after, field, cmd).ok


def test_verify_tap_detects_no_change():
    s = snap()
    btn = next(e for e in s.elements if e.res_id_tail == "btn_ok_continue")
    same = V.verify_tap(s, snap(), btn)
    assert not same.ok  # identical screen => tap unverified => retry
