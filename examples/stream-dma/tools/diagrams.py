#!/usr/bin/env python3
"""Generates the block diagrams in the stream-dma sidestories.

The SVGs are written between `<!-- diagram:NAME -->` and `<!-- /diagram:NAME -->` markers in each
sidestory.html, and the overview's geometry goes to .sidestory/dma-overview/widgets/layout.json, so the
static diagram and the simulation widget draw the same picture. Run from examples/stream-dma:

    python3 tools/diagrams.py

Styling lives in each sidestory's <style> (classes .blk, .w-data, .w-addr, .w-ctl ...), so the
diagrams take the reader's VS Code theme colours; nothing here is a literal colour. The overview
uses the diagram tokens (--cx-wire-data, --cx-box-fill, ...) and lights up per step: blocks and
wires carry `data-explain-on` with the steps they matter in, and the page wraps each copy in
`data-explain-diagram` (docs/GUIDE.md, "Diagrams that follow the steps").
"""
import json
import math
import re
from pathlib import Path
from html import escape

ROOT = Path(__file__).resolve().parent.parent
SIDESTORY = ROOT / '.sidestory'


class Diagram:
    def __init__(self, w, h, label, x0=0, y0=0):
        self.w, self.h, self.label, self.x0, self.y0 = w, h, label, x0, y0
        self.blocks, self.wires, self.extra = [], [], []

    def block(self, id, x, y, w, h, title, sub='', kind='data', ref=None, lines=(), on=None):
        """on: the anchor ids of the steps this block matters in (data-explain-on)."""
        self.blocks.append(dict(id=id, x=x, y=y, w=w, h=h, title=title, sub=sub, kind=kind, ref=ref, lines=list(lines), on=on))

    def wire(self, id, kind, pts, label='', at=None, anchor='middle', both=False, tag=None, on=None):
        """kind: data | addr | ctl. label lines split on '|'. at = (x, y) of the label's first line."""
        self.wires.append(dict(id=id, kind=kind, pts=pts, label=label, at=at, anchor=anchor, both=both, tag=tag or kind, on=on))

    @staticmethod
    def on_attr(item):
        return f' data-explain-on="{escape(" ".join(item["on"]))}"' if item.get('on') is not None else ''


    # ---- rendering
    @staticmethod
    def head(p, q, size):
        (x1, y1), (x2, y2) = p, q
        a = math.atan2(y2 - y1, x2 - x1)
        l, s = size * 1.6, size
        bx, by = x2 - l * math.cos(a), y2 - l * math.sin(a)
        px, py = -math.sin(a) * s, math.cos(a) * s
        return f'{x2:.1f},{y2:.1f} {bx + px:.1f},{by + py:.1f} {bx - px:.1f},{by - py:.1f}'

    def wire_svg(self, wdef):
        size = {'data': 5.5, 'addr': 4.5, 'ctl': 4}[wdef['kind']]
        pts = wdef['pts']
        d = 'M' + ' L'.join(f'{x},{y}' for x, y in pts)
        out = [f'<g class="w w-{wdef["kind"]}" data-wire="{wdef["id"]}"{self.on_attr(wdef)}>',
               f'<path class="w-line" d="{d}"/>',
               f'<polygon class="w-head" points="{self.head(pts[-2], pts[-1], size)}"/>']
        if wdef['both']:
            out.append(f'<polygon class="w-head" points="{self.head(pts[1], pts[0], size)}"/>')
        if wdef['label']:
            x, y = wdef['at']
            for i, line in enumerate(wdef['label'].split('|')):
                out.append(f'<text class="w-label" x="{x}" y="{y + i * 12}" text-anchor="{wdef["anchor"]}">{escape(line)}</text>')
        out.append('</g>')
        return ''.join(out)

    def block_svg(self, b):
        attrs = f' data-explain-ref="{b["ref"]}" aria-label="{escape(b["title"])}: show its code"' if b['ref'] else ''
        cx = b['x'] + b['w'] / 2
        out = [f'<g class="blk blk-{b["kind"]}" data-block="{b["id"]}"{attrs}{self.on_attr(b)}>',
               f'<rect class="blk-box" x="{b["x"]}" y="{b["y"]}" width="{b["w"]}" height="{b["h"]}" rx="6"/>']
        if b['kind'] in ('data', 'ctl'):
            out.append(f'<rect class="blk-bar" x="{b["x"]}" y="{b["y"]}" width="{b["w"]}" height="5" rx="2"/>')
        out.append(f'<text class="blk-title" x="{cx}" y="{b["y"] + 24}" text-anchor="middle">{escape(b["title"])}</text>')
        if b['sub']:
            out.append(f'<text class="blk-sub" x="{cx}" y="{b["y"] + 40}" text-anchor="middle">{escape(b["sub"])}</text>')
        for i, line in enumerate(b['lines']):
            out.append(f'<text class="blk-line" x="{cx}" y="{b["y"] + 58 + i * 13}" text-anchor="middle">{escape(line)}</text>')
        out.append('</g>')
        return ''.join(out)

    def svg(self, cls='dia'):
        body = ''.join(self.wire_svg(w) for w in self.wires) + ''.join(self.block_svg(b) for b in self.blocks) + ''.join(self.extra)
        # With links inside, a group: role="img" would make its children presentational to screen readers.
        role = 'group' if any(b['ref'] for b in self.blocks) else 'img'
        return (f'<svg class="{cls}" viewBox="{self.x0} {self.y0} {self.w} {self.h}" role="{role}" '
                f'aria-label="{escape(self.label)}">{body}</svg>')

    def layout(self):
        """The geometry the simulation widget draws (without the step tags, which only the page uses)."""
        strip = lambda items: [{k: v for k, v in i.items() if k != 'on'} for i in items]
        return dict(viewBox=[self.x0, self.y0, self.w, self.h], blocks=strip(self.blocks), wires=strip(self.wires))


def legend(d, x, y, items=(('data', 'data path (beats, 64 bits)'), ('addr', 'addresses and configuration'), ('ctl', 'control: strobes, handshakes, status'))):
    out = []
    for i, (kind, text) in enumerate(items):
        lx = x + i * 260
        out.append(f'<g class="w w-{kind} legend"><path class="w-line" d="M{lx},{y} L{lx + 44},{y}"/>'
                   f'<polygon class="w-head" points="{Diagram.head((lx, y), (lx + 52, y), 4.5)}"/>'
                   f'<text class="w-label" x="{lx + 60}" y="{y + 4}">{escape(text)}</text></g>')
    # Kept: a legend never fades while a step lights its parts.
    d.extra.append('<g class="legend-keys" data-explain-keep>' + ''.join(out) + '</g>')


# ---------------------------------------------------------------------------------------------
# The overview: the whole engine. Each block and wire names the steps (anchor ids) it matters in.
CTL = ['control']
DATA = ['datapath']
BP = ['backpressure']
ERR = ['errors']
READY = DATA + BP  # handshakes back along the data path
def overview():
    d = Diagram(1100, 610, 'Block diagram of dma_top. Data path, left to right along the bottom: the read bus feeds '
                'dma_rd_port, which pushes 64-bit beats into dma_fifo; dma_packer realigns them and dma_wr_port '
                'writes them to the write bus. Control along the top: the CPU programs dma_csr, which starts dma_ctrl; '
                'the FSM drives the two address generators and the ports with strobes and gets done, error and '
                'almost_full back. dma_csr raises irq.', y0=-6)
    # control plane
    d.block('cpu', 10, 40, 110, 80, 'CPU', 'driver', kind='ext', on=CTL + ERR)
    d.block('csr', 190, 30, 180, 110, 'dma_csr', 'registers', kind='ctl', ref='m-csr', lines=['SRC · DST · LEN', 'CTRL · STATUS · ERR'], on=CTL + ERR + ['m-csr'])
    d.block('ctrl', 470, 30, 220, 130, 'dma_ctrl', 'control FSM', kind='ctl', ref='m-ctrl', lines=['IDLE → LOAD → READ_BURST', '→ WAIT_DATA → WRITE_BURST', '→ WAIT_WRITE → DONE | ERROR'], on=CTL + BP + ERR + ['fsm', 'm-ctrl'])
    d.block('rdag', 140, 235, 170, 80, 'dma_addr_gen', 'u_rd_agen · source', kind='addr', ref='m-agen', lines=['≤16 beats, no 4 KB cross'], on=CTL + ['m-agen'])
    d.block('wrag', 800, 235, 170, 80, 'dma_addr_gen', 'u_wr_agen · destination', kind='addr', ref='m-agen', lines=['≤16 beats, no 4 KB cross'], on=CTL + ['m-agen'])
    # data plane
    d.block('rdbus', 10, 390, 50, 130, 'rd', 'bus', kind='ext', on=DATA + BP + ERR)
    d.block('rdp', 140, 390, 150, 130, 'dma_rd_port', 'read requests', kind='data', ref='m-rdport', lines=['one burst at a time', 'beats → FIFO'], on=DATA + BP + ERR + ['m-rdport'])
    d.block('fifo', 370, 390, 130, 130, 'dma_fifo', '32 × 64 bits', kind='data', ref='m-fifo', lines=['first word', 'falls through'], on=DATA + BP + ERR + ['m-fifo'])
    d.block('pack', 580, 390, 150, 130, 'dma_packer', 'byte realign', kind='data', ref='m-packer', lines=['rotate by dst−src', 'strobes at the ends'], on=DATA + BP + ERR + ['m-packer'])
    d.block('wrp', 810, 390, 150, 130, 'dma_wr_port', 'write bursts', kind='data', ref='m-wrport', lines=['last beat, response', 'stalls on ready'], on=DATA + BP + ERR + ['m-wrport'])
    d.block('wrbus', 1040, 390, 50, 130, 'wr', 'bus', kind='ext', on=DATA + BP + ERR)

    # data beats (thick)
    d.wire('rd_rsp_data', 'data', [(60, 450), (140, 450)], 'rd_rsp_data|[63:0]', (100, 424), on=DATA)
    d.wire('fifo_wdata', 'data', [(290, 450), (370, 450)], 'fifo_wdata|[63:0]', (330, 424), on=DATA)
    d.wire('fifo_rdata', 'data', [(500, 450), (580, 450)], 'fifo_rdata|[63:0]', (540, 424), on=DATA)
    d.wire('packed_data', 'data', [(730, 450), (810, 450)], 'packed_data|[63:0] +strb', (770, 424), on=DATA)
    d.wire('wr_dat_data', 'data', [(960, 450), (1040, 450)], 'wr_dat_data|[63:0]', (1000, 424), on=DATA)
    # handshakes going back (ready / full)
    d.wire('rd_rsp_ready', 'ctl', [(140, 495), (60, 495)], 'rd_rsp_ready', (100, 512), tag='ready', on=READY)
    d.wire('fifo_full', 'ctl', [(370, 495), (290, 495)], 'fifo_full', (330, 512), tag='ready', on=READY)
    d.wire('fifo_pop', 'ctl', [(580, 495), (500, 495)], 'fifo_pop', (540, 512), tag='ready', on=READY + ERR)
    d.wire('pk_ready', 'ctl', [(810, 495), (730, 495)], 'pk_ready', (770, 512), tag='ready', on=READY)
    d.wire('wr_dat_ready', 'ctl', [(1040, 495), (960, 495)], 'wr_dat_ready', (1000, 512), tag='ready', on=READY)
    # addresses and configuration
    d.wire('csr_bus', 'addr', [(120, 60), (190, 60)], 'csr bus', (155, 52), on=CTL)
    d.wire('rd_req', 'addr', [(140, 405), (60, 405)], 'rd_req_addr', (100, 385), on=DATA)
    d.wire('wr_req', 'addr', [(960, 405), (1040, 405)], 'wr_req_addr', (1000, 385), on=DATA)
    d.wire('src_cfg', 'addr', [(230, 140), (230, 235)], 'src_base · len', (238, 192), anchor='start', on=CTL)
    d.wire('dst_cfg', 'addr', [(330, 30), (330, 6), (940, 6), (940, 235)], 'dst_base · len', (700, 0), on=CTL)
    d.wire('rd_burst', 'addr', [(225, 315), (225, 390)], 'rd_burst_addr|· len', (218, 332), anchor='end', on=CTL)
    d.wire('wr_burst', 'addr', [(900, 315), (900, 390)], 'wr_burst_addr|· len', (908, 332), anchor='start', on=CTL)
    # control
    d.wire('start', 'ctl', [(370, 60), (470, 60)], 'start', (420, 52), on=CTL)
    d.wire('status', 'ctl', [(470, 110), (370, 110)], 'done_set|err_set', (420, 90), on=CTL + ERR)
    d.wire('irq', 'ctl', [(190, 105), (120, 105)], 'irq', (155, 97), on=CTL + ERR)
    d.wire('c_rdag', 'ctl', [(480, 160), (480, 275), (310, 275)], 'load · rd_start ⇄|rd_has_burst', (395, 258), both=True, on=CTL)
    d.wire('c_rdp', 'ctl', [(505, 160), (505, 350), (250, 350), (250, 390)], 'rd_start ↓   rd_done · rd_err ↑', (378, 343), both=True, on=CTL + ERR)
    d.wire('almost_full', 'ctl', [(465, 390), (465, 368), (535, 368), (535, 160)], 'fifo_almost_full|fifo_push', (542, 300), anchor='start', on=CTL + BP)
    d.wire('c_pack', 'ctl', [(640, 160), (640, 390)], 'load · drain', (647, 372), anchor='start', on=CTL + ERR)
    d.wire('c_wrp', 'ctl', [(665, 160), (665, 350), (850, 350), (850, 390)], 'wr_start ↓   wr_done · wr_err ↑', (758, 343), both=True, on=CTL + BP + ERR)
    d.wire('c_wrag', 'ctl', [(690, 110), (885, 110), (885, 235)], 'wr_start · wr_burst_len ⇄|wr_has_burst', (790, 96), both=True, on=CTL)
    legend(d, 140, 575)
    return d


# ---------------------------------------------------------------------------------------------
# Per-module internals: datapath (blue) inside the module vs its control (orange).
def m_ctrl():
    d = Diagram(760, 330, 'Inside dma_ctrl: the state register and next-state logic (control) take start, done, '
                'error and almost_full inputs and the credit check; the credit check compares two beat counters '
                '(in_rcvd_q, counting FIFO pushes, and out_issued_q, adding each write burst length). Outputs are '
                'one-cycle strobes: load, rd_start, wr_start, done_set, err_set.')
    d.block('ns', 250, 20, 220, 120, 'next-state logic', 'always_comb · unique case', kind='ctl', ref='fsm', lines=['8 states', 'one strobe per state'])
    d.block('sq', 530, 40, 120, 80, 'state_q', 'register', kind='ctl', ref='regs')
    d.block('cnt', 20, 190, 200, 110, 'beat counters', 'in_rcvd_q · out_issued_q', kind='data', ref='regs', lines=['+1 per FIFO push', '+len per wr_start'])
    d.block('cr', 290, 205, 180, 80, 'credit_ok', 'comparator', kind='data', ref='credit')
    d.wire('in', 'ctl', [(20, 60), (250, 60)], 'start · rd_done · wr_done|has_burst · almost_full · errs', (135, 40))
    d.wire('nsq', 'ctl', [(470, 80), (530, 80)], 'state_d', (500, 72))
    d.wire('fb', 'ctl', [(590, 120), (590, 160), (360, 160), (360, 140)], 'state_q', (480, 175))
    d.wire('cc', 'data', [(220, 245), (290, 245)], '', None)
    d.wire('ok', 'ctl', [(380, 205), (380, 140)], 'credit_ok', (386, 180), anchor='start')
    d.wire('push', 'ctl', [(120, 160), (120, 190)], 'fifo_push · wr_start', (128, 176), anchor='start')
    d.wire('out', 'ctl', [(650, 80), (740, 80)], 'busy', (695, 72))
    d.wire('strobes', 'ctl', [(470, 115), (510, 115), (510, 260), (740, 260)], 'load · rd_start · wr_start|done_set · err_set', (630, 240))
    legend(d, 20, 318, (('data', 'counters, comparison'), ('ctl', 'state, strobes')))
    return d


def m_agen():
    d = Diagram(760, 300, 'Inside dma_addr_gen: two registers, addr_q and left_q, hold where the next burst starts and how many '
                'beats remain. Three limits feed a minimum: MAX_BURST, left_q and the beats to the next 4 KB boundary. '
                'burst_ack from dma_ctrl advances both registers by the chosen burst length.')
    d.block('regs', 20, 40, 170, 100, 'addr_q · left_q', 'registers', kind='data', ref='agen-regs', lines=['load: base, total_beats', 'ack: += / −= burst_len'])
    d.block('to4k', 260, 20, 160, 60, 'to_4k', '512 − addr_q[11:3]', kind='data', ref='agen-4k')
    d.block('min', 490, 60, 150, 100, 'min of three', 'MAX_BURST · to_4k · left_q', kind='data', ref='agen-limits')
    d.block('tot', 260, 200, 160, 70, 'total_beats', '(off + len + 7) / 8', kind='data', ref='agen-total')
    d.wire('a', 'data', [(190, 60), (260, 60)], 'addr_q', (225, 52))
    d.wire('b', 'data', [(420, 50), (455, 50), (455, 90), (490, 90)], '', None)
    d.wire('c', 'data', [(190, 120), (490, 120)], 'left_q', (340, 112))
    d.wire('len', 'data', [(640, 110), (740, 110)], 'burst_len', (690, 102))
    d.wire('ad', 'data', [(105, 140), (105, 180), (740, 180)], 'burst_addr', (690, 172))
    d.wire('tt', 'addr', [(260, 235), (60, 235), (60, 140)], 'base · len', (160, 228))
    d.wire('ack', 'ctl', [(740, 250), (560, 250), (560, 230), (130, 230), (130, 140)], 'load · burst_ack', (650, 243))
    d.wire('hb', 'ctl', [(150, 140), (150, 160), (740, 160)], 'has_burst', (690, 155))
    legend(d, 20, 290, (('data', 'addresses and counts'), ('addr', 'configuration'), ('ctl', 'control')))
    return d


def m_packer():
    d = Diagram(760, 300, 'Inside dma_packer: in_data and the previous beat prev_q form a 128-bit window; a barrel shift by '
                '(8 − shift) bytes cuts out_data. Control: the in_left and out_left counters, the prime and first flags, and '
                'the strobe masks; they produce in_ready, out_valid and out_strb.')
    d.block('prev', 30, 40, 140, 60, 'prev_q', 'last input beat', kind='data', ref='pk-window')
    d.block('win', 240, 30, 170, 80, 'window', '{in_data, prev_q} · 128 b', kind='data', ref='pk-window')
    d.block('rot', 480, 30, 160, 80, 'rotate', '>> (8 − shift) × 8', kind='data', ref='pk-window')
    d.block('ctl', 240, 170, 230, 90, 'beat control', 'prime · flush · in_left · out_left', kind='ctl', ref='pk-handshake')
    d.block('strb', 540, 170, 160, 90, 'strobes', 'first_strb & last_strb', kind='ctl', ref='pk-strobes')
    d.wire('in', 'data', [(20, 140), (220, 140), (220, 70), (240, 70)], 'in_data', (120, 132))
    d.wire('pv', 'data', [(170, 70), (240, 70)], '', None)
    d.wire('fb', 'data', [(200, 140), (200, 120), (100, 120), (100, 100)], '', None)
    d.wire('w', 'data', [(410, 70), (480, 70)], '', None)
    d.wire('o', 'data', [(640, 70), (740, 70)], 'out_data', (690, 62))
    d.wire('sh', 'ctl', [(420, 170), (420, 130), (560, 130), (560, 110)], 'shift_q · flush', (490, 125))
    d.wire('hs', 'ctl', [(20, 215), (240, 215)], 'in_valid · out_ready', (130, 207))
    d.wire('rd', 'ctl', [(240, 245), (20, 245)], 'in_ready', (130, 260))
    d.wire('st', 'ctl', [(700, 215), (740, 215)], '', None)
    d.wire('ov', 'ctl', [(470, 250), (500, 250), (500, 280), (740, 280)], 'out_valid', (690, 274))
    d.extra.append('<text class="w-label" x="745" y="212" text-anchor="end"> </text>')
    legend(d, 20, 300, (('data', 'bytes'), ('ctl', 'control')))
    d.h = 315
    return d


def m_fifo():
    d = Diagram(760, 250, 'Inside dma_fifo: a 32-entry memory written at wptr_q and read at rptr_q (first word falls through). '
                'count_q tracks occupancy and drives full, empty and almost_full.')
    d.block('mem', 250, 30, 220, 110, 'mem[32]', '64-bit entries', kind='data', ref='ff-store', lines=['write at wptr_q', 'read at rptr_q'])
    d.block('ptr', 250, 170, 220, 60, 'wptr_q · rptr_q · count_q', 'occupancy', kind='ctl', ref='ff-count')
    d.wire('wd', 'data', [(20, 85), (250, 85)], 'wdata', (135, 77))
    d.wire('rd', 'data', [(470, 85), (740, 85)], 'rdata', (605, 77))
    d.wire('push', 'ctl', [(20, 190), (250, 190)], 'push', (135, 182))
    d.wire('pop', 'ctl', [(740, 190), (470, 190)], 'pop', (605, 182))
    d.wire('flags', 'ctl', [(470, 215), (740, 215)], 'full · empty · almost_full', (605, 232))
    legend(d, 20, 246, (('data', 'beats'), ('ctl', 'control')))
    d.h = 260
    return d


def m_port(kind):
    rd = kind == 'rd'
    name = 'dma_rd_port' if rd else 'dma_wr_port'
    d = Diagram(760, 250, f'Inside {name}: a request register (valid until the bus takes it), a beat counter, and a straight '
                f'data path {"from the read response to the FIFO" if rd else "from the packer to the write data channel"}.')
    pre = 'rp' if rd else 'wp'
    d.block('req', 250, 20, 220, 60, 'req_q · addr_q · len_q', 'request register', kind='ctl', ref=f'{pre}-req')
    d.block('cnt', 250, 170, 220, 60, 'left_q', 'beats to go', kind='ctl', ref=f'{pre}-beats')
    d.block('dp', 250, 100, 220, 50, 'data (wires only)', '', kind='data', ref=f'{pre}-data')
    if rd:
        d.wire('start', 'ctl', [(20, 40), (250, 40)], 'start · addr · len', (135, 32))
        d.wire('req', 'addr', [(470, 40), (740, 40)], 'rd_req_valid · addr · len', (605, 32))
        d.wire('d', 'data', [(740, 125), (470, 125)], 'rd_rsp_data', (605, 117))
        d.wire('f', 'data', [(250, 125), (20, 125)], 'fifo_wdata', (135, 117))
        d.wire('rdy', 'ctl', [(470, 200), (740, 200)], 'rd_rsp_ready', (605, 192))
        d.wire('full', 'ctl', [(20, 215), (250, 215)], 'fifo_full', (135, 207))
        d.wire('done', 'ctl', [(250, 185), (20, 185)], 'done · err', (135, 177))
    else:
        d.wire('start', 'ctl', [(20, 40), (250, 40)], 'start · addr · len', (135, 32))
        d.wire('req', 'addr', [(470, 40), (740, 40)], 'wr_req_valid · addr · len', (605, 32))
        d.wire('d', 'data', [(20, 125), (250, 125)], 'packed_data · strb', (135, 117))
        d.wire('f', 'data', [(470, 125), (740, 125)], 'wr_dat_data · strb', (605, 117))
        d.wire('rdy', 'ctl', [(740, 200), (470, 200)], 'wr_dat_ready · wr_rsp', (605, 192))
        d.wire('full', 'ctl', [(250, 215), (20, 215)], 'pk_ready', (135, 207))
        d.wire('done', 'ctl', [(250, 185), (20, 185)], 'done · err', (135, 177))
        d.wire('last', 'ctl', [(470, 225), (740, 225)], 'wr_dat_last', (605, 240))
    legend(d, 20, 262, (('data', 'beats'), ('addr', 'request'), ('ctl', 'control')))
    d.h = 275
    return d


def m_csr():
    d = Diagram(760, 230, 'Inside dma_csr: a write decoder updates the configuration registers (SRC, DST, LEN, irq_en) and '
                'clears status bits; start is a one-cycle pulse; done and error are set by dma_ctrl; irq is irq_en and '
                '(done or error).')
    d.block('dec', 200, 20, 180, 70, 'write decode', 'csr_addr · csr_we', kind='ctl', ref='csr-write')
    d.block('cfg', 450, 20, 180, 70, 'SRC · DST · LEN', 'config registers', kind='data', ref='csr-write')
    d.block('st', 200, 140, 180, 70, 'done_q · err_q', 'status (W1C)', kind='ctl', ref='csr-write')
    d.block('irq', 450, 140, 180, 70, 'irq', 'irq_en & (done | err)', kind='ctl', ref='csr-irq')
    d.wire('bus', 'addr', [(20, 55), (200, 55)], 'csr bus', (110, 47))
    d.wire('cfgw', 'data', [(380, 55), (450, 55)], '', None)
    d.wire('cfgo', 'addr', [(630, 55), (740, 55)], 'src · dst · len', (685, 47))
    d.wire('set', 'ctl', [(20, 175), (200, 175)], 'done_set · err_set', (110, 167))
    d.wire('i', 'ctl', [(380, 175), (450, 175)], '', None)
    d.wire('io', 'ctl', [(630, 175), (740, 175)], 'irq', (685, 167))
    d.wire('stt', 'ctl', [(290, 90), (290, 140)], 'start (pulse)', (298, 120), anchor='start')
    legend(d, 20, 236, (('data', 'register values'), ('addr', 'bus / config out'), ('ctl', 'control')))
    d.h = 250
    return d


# ---------------------------------------------------------------------------------------------
# The FSM state graph (static fallback for the FSM widget). Edges as in dma_ctrl's case statement.
FSM_POS = {
    'IDLE': (90, 200), 'LOAD': (160, 70), 'READ_BURST': (360, 70), 'WAIT_DATA': (640, 70),
    'WRITE_BURST': (640, 330), 'WAIT_WRITE': (360, 330), 'DONE': (200, 420), 'ERROR': (830, 200),
}
FSM_EDGES = [
    ('IDLE', 'LOAD', 'start'), ('LOAD', 'READ_BURST', ''), ('LOAD', 'ERROR', 'len_zero'),
    ('READ_BURST', 'WAIT_DATA', 'rd_start'), ('READ_BURST', 'WRITE_BURST', 'no reads left | almost_full'),
    ('WAIT_DATA', 'WRITE_BURST', 'rd_done, credit_ok'), ('WAIT_DATA', 'READ_BURST', 'rd_done, no credit'),
    ('WAIT_DATA', 'ERROR', 'rd_err'), ('WRITE_BURST', 'READ_BURST', 'wr_start, or no credit'),
    ('WRITE_BURST', 'WAIT_WRITE', 'wr_busy'), ('WRITE_BURST', 'DONE', 'no writes left'),
    ('WAIT_WRITE', 'READ_BURST', 'wr_done'), ('DONE', 'IDLE', 'done_set'), ('ERROR', 'IDLE', 'ports idle: err_set'),
]
FSM_BEND = {('LOAD', 'ERROR'): -260, ('ERROR', 'IDLE'): -600, ('DONE', 'IDLE'): -50, ('WRITE_BURST', 'DONE'): 40}
NODE_W, NODE_H = 124, 34


def edge_path(a, b, bend):
    (x1, y1), (x2, y2) = a, b
    mx, my = (x1 + x2) / 2, (y1 + y2) / 2
    dx, dy = x2 - x1, y2 - y1
    L = math.hypot(dx, dy) or 1
    nx, ny = -dy / L, dx / L
    cx, cy = mx + nx * bend, my + ny * bend

    def trim(px, py, qx, qy, pad):
        # where the line from the node's centre towards (qx, qy) leaves its pill, plus a gap
        vx, vy = qx - px, qy - py
        t = min((NODE_W / 2 + pad) / abs(vx) if vx else 1e9, (NODE_H / 2 + pad) / abs(vy) if vy else 1e9)
        return px + vx * t, py + vy * t
    sx, sy = trim(x1, y1, cx, cy, 2)
    ex, ey = trim(x2, y2, cx, cy, 4)
    lx, ly = (sx + 2 * cx + ex) / 4, (sy + 2 * cy + ey) / 4
    return sx, sy, cx, cy, ex, ey, lx, ly


def fsm_static():
    out = []
    pairs = {(a, b) for a, b, _ in FSM_EDGES}
    for a, b, label in FSM_EDGES:
        bend = FSM_BEND.get((a, b), 34 if (b, a) in pairs else 0)
        sx, sy, cx, cy, ex, ey, lx, ly = edge_path(FSM_POS[a], FSM_POS[b], bend)
        kind = 'err' if b == 'ERROR' else 'ctl'
        out.append(f'<g class="w w-{kind}"><path class="w-line" d="M{sx:.1f},{sy:.1f} Q{cx:.1f},{cy:.1f} {ex:.1f},{ey:.1f}"/>'
                   f'<polygon class="w-head" points="{Diagram.head((cx, cy), (ex, ey), 4.5)}"/>'
                   + (f'<text class="w-label fsm-elabel" x="{lx:.1f}" y="{ly + 4:.1f}" text-anchor="middle">{escape(label)}</text>' if label else '')
                   + '</g>')
    for s, (x, y) in FSM_POS.items():
        cls = 'st-end' if s in ('DONE', 'ERROR') else 'st-idle' if s == 'IDLE' else ''
        out.append(f'<g class="st {cls}"><rect x="{x - NODE_W / 2}" y="{y - NODE_H / 2}" width="{NODE_W}" height="{NODE_H}" rx="17"/>'
                   f'<text x="{x}" y="{y + 4}" text-anchor="middle">{s}</text></g>')
    out.append('<text class="w-label" x="830" y="240" text-anchor="middle">+ wr_err from any state</text>')
    return ('<svg class="dia fsm" viewBox="0 -14 900 530" role="img" aria-label="State graph of dma_ctrl. IDLE goes to LOAD on start. '
            'LOAD goes to READ_BURST, or to ERROR on a zero length. READ_BURST issues a read (rd_start) and waits in WAIT_DATA, or goes to '
            'WRITE_BURST when nothing is left to read or the FIFO is almost full. WAIT_DATA goes to WRITE_BURST when there is credit, else back '
            'to READ_BURST, or to ERROR on a read error. WRITE_BURST starts a write and goes back to READ_BURST while it runs, waits in '
            'WAIT_WRITE while the write port is busy, or goes to DONE when no writes remain. WAIT_WRITE returns to READ_BURST on wr_done. '
            'A write error from any state goes to ERROR, which drains the datapath until both ports are idle. DONE and ERROR return to IDLE.">'
            + ''.join(out) + '</svg>')


# Shared diagram styles, spliced into each sidestory's <style> between /* dia-css */ markers.
DIA_CSS = """
  .dia { display: block; width: 100%; height: auto; font-family: var(--vscode-editor-font-family); overflow: visible; }
  .dia text { fill: var(--vscode-editor-foreground); }
  .dia .w-line { fill: none; stroke-linejoin: round; }
  .dia .w-data .w-line { stroke: var(--vscode-charts-blue); stroke-width: 5; }
  .dia .w-data .w-head { fill: var(--vscode-charts-blue); }
  .dia .w-addr .w-line { stroke: var(--vscode-charts-purple); stroke-width: 2.5; }
  .dia .w-addr .w-head { fill: var(--vscode-charts-purple); }
  .dia .w-ctl .w-line { stroke: var(--vscode-charts-orange); stroke-width: 1.5; stroke-dasharray: 5 4; }
  .dia .w-ctl .w-head { fill: var(--vscode-charts-orange); }
  .dia .w-err .w-line { stroke: var(--vscode-charts-red); stroke-width: 1.5; stroke-dasharray: 2 3; }
  .dia .w-err .w-head { fill: var(--vscode-charts-red); }
  .dia text.w-label { font-size: 10.5px; fill: var(--vscode-descriptionForeground); }
  .dia .blk-box { fill: var(--vscode-editorWidget-background, var(--vscode-editor-background)); stroke: var(--vscode-editorWidget-border, var(--vscode-panel-border)); stroke-width: 1.2; }
  .dia .blk-data .blk-bar { fill: var(--vscode-charts-blue); }
  .dia .blk-ctl .blk-bar { fill: var(--vscode-charts-orange); }
  .dia .blk-addr .blk-box { stroke: var(--vscode-charts-purple); stroke-width: 1.8; }
  .dia .blk-ext .blk-box { fill: none; stroke: var(--vscode-descriptionForeground); stroke-dasharray: 3 3; }
  .dia text.blk-title { font-weight: 600; font-size: 13px; }
  .dia text.blk-sub, .dia text.blk-line { font-size: 10.5px; fill: var(--vscode-descriptionForeground); }
  .dia [data-explain-ref] { cursor: pointer; text-decoration: none; }
  .dia [data-explain-ref]:hover .blk-box, .dia [data-explain-ref]:focus-visible .blk-box { stroke: var(--vscode-focusBorder); stroke-width: 2.5; }
  .dia [data-explain-ref]:focus-visible { outline: none; }
  .dia .st rect { fill: var(--vscode-editorWidget-background, var(--vscode-editor-background)); stroke: var(--vscode-charts-orange); stroke-width: 1.5; }
  .dia .st.st-idle rect { stroke-width: 3; }
  .dia .st.st-end rect { stroke: var(--vscode-charts-green); }
  .dia .st text { font-size: 12px; font-weight: 600; }
  .dia text.fsm-elabel { font-size: 10px; paint-order: stroke; stroke: var(--vscode-editor-background); stroke-width: 3px; }
  /* one path in focus: the rest fades */
  .focus-data .dia .w-ctl:not(.legend):not([data-wire$=ready]):not([data-wire=fifo_full]):not([data-wire=fifo_pop]), .focus-data .dia .w-addr:not(.legend) { opacity: .15; }
  .focus-data .dia .blk-ctl, .focus-data .dia .blk-addr { opacity: .4; }
  .focus-control .dia .w-data:not(.legend), .focus-control .dia [data-wire$=ready], .focus-control .dia [data-wire=fifo_full], .focus-control .dia [data-wire=fifo_pop] { opacity: .15; }
  .focus-control .dia .blk-data { opacity: .4; }
  .focus-bp .dia .w:not(.legend):not([data-wire=almost_full]):not([data-wire$=ready]):not([data-wire=fifo_full]):not([data-wire=fifo_pop]):not([data-wire=c_wrp]) { opacity: .15; }
  .focus-bp .dia [data-wire=almost_full] .w-line, .focus-bp .dia [data-wire$=ready] .w-line, .focus-bp .dia [data-wire=fifo_full] .w-line { stroke-width: 3; stroke-dasharray: none; }
  .focus-err .dia .w:not(.legend):not([data-wire=status]):not([data-wire=irq]):not([data-wire=c_rdp]):not([data-wire=c_wrp]):not([data-wire=c_pack]) { opacity: .15; }
  .focus-err .dia [data-wire=status] .w-line, .focus-err .dia [data-wire=irq] .w-line, .focus-err .dia [data-wire=c_rdp] .w-line, .focus-err .dia [data-wire=c_wrp] .w-line, .focus-err .dia [data-wire=c_pack] .w-line { stroke-width: 3; stroke-dasharray: none; }
  @media (forced-colors: active) { .dia .w-ctl .w-line, .dia .w-err .w-line { stroke-dasharray: 5 4; } }
"""


# The overview's diagram styles: the diagram tokens (they follow the theme, high contrast and forced colors
# included), and how a part the current step lights up looks. Links get the panel's built-in look.
OVERVIEW_CSS = """
  .dia { display: block; width: 100%; height: auto; font-family: var(--vscode-editor-font-family); overflow: visible; }
  .dia text { fill: var(--cx-box-text); }
  .dia .w-line { fill: none; stroke-linejoin: round; }
  .dia .w-data .w-line { stroke: var(--cx-wire-data); stroke-width: 5; }
  .dia .w-data .w-head { fill: var(--cx-wire-data); }
  .dia .w-addr .w-line { stroke: var(--cx-wire-addr); stroke-width: 2.5; }
  .dia .w-addr .w-head { fill: var(--cx-wire-addr); }
  .dia .w-ctl .w-line { stroke: var(--cx-wire-ctrl); stroke-width: 1.5; stroke-dasharray: var(--cx-dash-ctrl); }
  .dia .w-ctl .w-head { fill: var(--cx-wire-ctrl); }
  .dia text.w-label { font-size: 10.5px; fill: var(--cx-label); }
  .dia .blk-box { fill: var(--cx-box-fill); stroke: var(--cx-box-stroke); stroke-width: 1.2; }
  .dia .blk-data .blk-bar { fill: var(--cx-wire-data); }
  .dia .blk-ctl .blk-bar { fill: var(--cx-wire-ctrl); }
  .dia .blk-addr .blk-box { stroke: var(--cx-wire-addr); stroke-width: 1.8; }
  .dia .blk-ext .blk-box { fill: none; stroke: var(--cx-label); stroke-dasharray: 3 3; }
  .dia text.blk-title { font-weight: 600; font-size: 13px; }
  .dia text.blk-sub, .dia text.blk-line { font-size: 10.5px; fill: var(--cx-label); }
  /* lit by the current step (data-explain-on): a block in the step's color, control wires thicker */
  .dia .blk.cx-on .blk-box { stroke: var(--cx-on); stroke-width: 2.5; }
  .dia .w-ctl.cx-on .w-line { stroke-width: 2.5; }
"""


def splice_css(path, css=DIA_CSS):
    text = path.read_text()
    pat = re.compile(r'(/\* dia-css \*/)(.*?)(/\* /dia-css \*/)', re.S)
    if pat.search(text):
        path.write_text(pat.sub(lambda m: m.group(1) + css + '  ' + m.group(3), text))


def splice(path, name, svg):
    text = path.read_text()
    pat = re.compile(rf'(<!-- diagram:{name} -->)(.*?)(<!-- /diagram:{name} -->)', re.S)
    if not pat.search(text):
        raise SystemExit(f'{path}: no diagram:{name} markers')
    text = pat.sub(lambda m: m.group(1) + '\n' + svg + '\n' + m.group(3), text)
    path.write_text(text)


def main():
    ov = overview()
    (SIDESTORY / 'dma-overview' / 'widgets').mkdir(parents=True, exist_ok=True)
    (SIDESTORY / 'dma-overview' / 'widgets' / 'layout.json').write_text(json.dumps(ov.layout(), separators=(',', ':')) + '\n')
    page = SIDESTORY / 'dma-overview' / 'sidestory.html'
    for name in ('overview', 'control', 'datapath', 'backpressure', 'errors'):
        if f'<!-- diagram:{name} -->' in page.read_text():
            splice(page, name, ov.svg())
    jobs = [('dma-ctrl', 'inside', m_ctrl), ('dma-addr-gen', 'inside', m_agen), ('dma-packer', 'inside', m_packer),
            ('dma-fifo', 'inside', m_fifo), ('dma-rd-port', 'inside', lambda: m_port('rd')),
            ('dma-wr-port', 'inside', lambda: m_port('wr')), ('dma-csr', 'inside', m_csr)]
    splice_css(page, OVERVIEW_CSS)
    for folder, name, fn in jobs:
        p = SIDESTORY / folder / 'sidestory.html'
        if p.exists():
            splice(p, name, fn().svg())
            splice_css(p)
    p = SIDESTORY / 'dma-ctrl' / 'sidestory.html'
    if p.exists() and '<!-- diagram:fsm -->' in p.read_text():
        splice(p, 'fsm', fsm_static())


if __name__ == '__main__':
    main()
