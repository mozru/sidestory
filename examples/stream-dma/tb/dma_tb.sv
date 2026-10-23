// dma_tb: a self-checking testbench for dma_top. A byte-addressed memory model answers the
// read and write channels (with random stalls), and each test copies LEN bytes from SRC to
// DST at random alignments and compares.
//
// Build and run from examples/stream-dma with Verilator 5:
//   (verilator) --binary --top-module dma_tb tb/dma_tb.sv rtl/dma_top.sv rtl/dma_csr.sv ...
//   then obj_dir/Vdma_tb; it prints PASS.
module dma_tb;
  localparam int AW = 32, DW = 64, NB = 8, BLW = 5, MEM = 1 << 16;

  logic clk = 0, rst_n = 0;
  always #5 clk = ~clk;

  logic           csr_we;
  logic [4:2]     csr_addr;
  logic [31:0]    csr_wdata, csr_rdata;
  logic           irq;
  logic           rd_req_valid, rd_req_ready, rd_rsp_valid, rd_rsp_ready, rd_rsp_err;
  logic [AW-1:0]  rd_req_addr;
  logic [BLW-1:0] rd_req_len;
  logic [DW-1:0]  rd_rsp_data;
  logic           wr_req_valid, wr_req_ready, wr_dat_valid, wr_dat_ready, wr_dat_last;
  logic           wr_rsp_valid, wr_rsp_err;
  logic [AW-1:0]  wr_req_addr;
  logic [BLW-1:0] wr_req_len;
  logic [DW-1:0]  wr_dat_data;
  logic [NB-1:0]  wr_dat_strb;
  logic [5:0]     fifo_level;

  dma_top dut (.*);

  logic [7:0] mem [MEM];
  logic [7:0] ref_mem [MEM];
  int stall_pct = 0;
  int rd_err_beat = -1, wr_err_burst = -1, rd_beats = 0, wr_bursts = 0;

  // ---- read slave: one burst at a time, random gaps between beats
  logic [AW-1:0] r_addr; int r_left = 0;
  assign rd_req_ready = (r_left == 0);
  always @(posedge clk) begin
    if (rd_req_valid && rd_req_ready) begin
      if ((rd_req_addr >> 12) != ((rd_req_addr + 32'(rd_req_len) * 8 - 1) >> 12))
        $fatal(1, "read burst crosses 4 KB: %h len %0d", rd_req_addr, rd_req_len);
      r_addr <= rd_req_addr; r_left <= int'(rd_req_len);
    end else if (rd_rsp_valid && rd_rsp_ready) begin
      r_addr <= r_addr + 8; r_left <= r_left - 1; rd_beats <= rd_beats + 1;
    end
  end
  always_comb begin
    rd_rsp_valid = r_left != 0 && (($urandom % 100) >= stall_pct);
    rd_rsp_err   = rd_beats == rd_err_beat;
    for (int b = 0; b < NB; b++) rd_rsp_data[b*8 +: 8] = mem[(r_addr + b) % MEM];
  end

  // ---- write slave
  logic [AW-1:0] w_addr; int w_left = 0; logic w_rsp = 0;
  assign wr_req_ready = (w_left == 0) && !w_rsp;
  always_comb wr_dat_ready = w_left != 0 && (($urandom % 100) >= stall_pct);
  assign wr_rsp_valid = w_rsp;
  assign wr_rsp_err = w_rsp && wr_bursts == wr_err_burst;
  always @(posedge clk) begin
    if (wr_req_valid && wr_req_ready) begin
      if ((wr_req_addr >> 12) != ((wr_req_addr + 32'(wr_req_len) * 8 - 1) >> 12))
        $fatal(1, "write burst crosses 4 KB: %h len %0d", wr_req_addr, wr_req_len);
      w_addr <= wr_req_addr; w_left <= int'(wr_req_len);
    end else if (wr_dat_valid && wr_dat_ready) begin
      for (int b = 0; b < NB; b++) if (wr_dat_strb[b]) mem[(w_addr + b) % MEM] <= wr_dat_data[b*8 +: 8];
      if (wr_dat_last != (w_left == 1)) $fatal(1, "wr_dat_last mismatch");
      w_addr <= w_addr + 8; w_left <= w_left - 1;
      if (w_left == 1) w_rsp <= 1;
    end else if (w_rsp) begin w_rsp <= 0; wr_bursts <= wr_bursts + 1; end
  end

  task automatic csr_write(input logic [4:2] a, input logic [31:0] d);
    @(negedge clk); csr_we = 1; csr_addr = a; csr_wdata = d;
    @(negedge clk); csr_we = 0;
  endtask

  task automatic run(input int src, input int dst, input int len, input logic [1:0] expect_err = 0);
    for (int i = 0; i < MEM; i++) begin mem[i] = 8'($urandom); ref_mem[i] = mem[i]; end
    for (int i = 0; i < len; i++) ref_mem[dst + i] = ref_mem[src + i];
    csr_write(3'd2, src); csr_write(3'd3, dst); csr_write(3'd4, len);
    csr_write(3'd0, 32'h3);  // irq_en | start
    fork : wait_irq
      begin wait (irq); end
      begin repeat (200000) @(posedge clk); $fatal(1, "timeout src=%0d dst=%0d len=%0d", src, dst, len); end
    join_any
    disable wait_irq;
    $display("run src=%h dst=%h len=%0d done at %0t", src, dst, len, $time);
    @(negedge clk); csr_addr = 3'd1; #1;
    if (expect_err != 0) begin
      if (csr_rdata[2:0] != 3'b100) $fatal(1, "status %b, expected error", csr_rdata[2:0]);
      csr_addr = 3'd5; #1;
      if (csr_rdata[1:0] != expect_err) $fatal(1, "error code %0d, expected %0d", csr_rdata[1:0], expect_err);
      repeat (40) @(posedge clk);  // let the bus finish what was in flight
      csr_write(3'd1, 32'h6);
      return;
    end
    if (csr_rdata[2:0] != 3'b010) $fatal(1, "status %b", csr_rdata[2:0]);
    for (int i = 0; i < MEM; i++)
      if (mem[i] !== ref_mem[i]) $fatal(1, "mismatch at %0d src=%0d dst=%0d len=%0d", i, src, dst, len);
    csr_write(3'd1, 32'h6);
  endtask

  initial begin
    csr_we = 0; csr_addr = 0; csr_wdata = 0;
    repeat (3) @(posedge clk); rst_n = 1;
    run('h0100, 'h2000, 64);           // aligned
    run('h0103, 'h2006, 1);            // a single byte
    run('h0105, 'h2002, 300);          // dst_off < src_off: prime
    run('h0FF3, 'h3FFD, 777);          // both cross 4 KB boundaries
    run('h0100, 'h2000, 0, 2'd1);           // zero length
    rd_beats = 0; rd_err_beat = 20;
    run('h0100, 'h2000, 400, 2'd2);         // read error
    rd_err_beat = -1; wr_bursts = 0; wr_err_burst = 1;
    run('h0100, 'h2000, 400, 2'd3);         // write error
    wr_err_burst = -1;
    stall_pct = 40;
    for (int t = 0; t < 40; t++)
      run(int'($urandom % 32'h6000), 32'h8000 + int'($urandom % 32'h6000), 1 + int'($urandom % 2000));
    $display("PASS");
    $finish;
  end
endmodule
