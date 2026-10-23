// dma_top: a memory-to-memory stream DMA engine.
//
// Software writes SRC, DST and LEN and sets CTRL.start. The engine reads the source in bursts,
// queues the beats in a FIFO, realigns the bytes to the destination's offset, and writes them
// out in bursts, then raises irq.
//
//   data:    rd_rsp_data -> dma_rd_port -> dma_fifo -> dma_packer -> dma_wr_port -> wr_dat_data
//   control: dma_csr -> dma_ctrl -> {dma_addr_gen x2, dma_rd_port, dma_packer, dma_wr_port}
module dma_top #(
  parameter int AW         = 32,
  parameter int DW         = 64,
  parameter int LW         = 20,
  parameter int MAX_BURST  = 16,
  parameter int FIFO_DEPTH = 32,
  parameter int NB         = DW / 8,
  parameter int BW         = LW - 2,
  parameter int BLW        = $clog2(MAX_BURST) + 1
) (
  input  logic           clk,
  input  logic           rst_n,
  // register bus
  input  logic           csr_we,
  input  logic [4:2]     csr_addr,
  input  logic [31:0]    csr_wdata,
  output logic [31:0]    csr_rdata,
  output logic           irq,
  // read request / response
  output logic           rd_req_valid,
  input  logic           rd_req_ready,
  output logic [AW-1:0]  rd_req_addr,
  output logic [BLW-1:0] rd_req_len,
  input  logic           rd_rsp_valid,
  output logic           rd_rsp_ready,
  input  logic [DW-1:0]  rd_rsp_data,
  input  logic           rd_rsp_err,
  // write request / data / response
  output logic           wr_req_valid,
  input  logic           wr_req_ready,
  output logic [AW-1:0]  wr_req_addr,
  output logic [BLW-1:0] wr_req_len,
  output logic           wr_dat_valid,
  input  logic           wr_dat_ready,
  output logic [DW-1:0]  wr_dat_data,
  output logic [NB-1:0]  wr_dat_strb,
  output logic           wr_dat_last,
  input  logic           wr_rsp_valid,
  input  logic           wr_rsp_err,
  // debug: FIFO occupancy
  output logic [$clog2(FIFO_DEPTH):0] fifo_level
);

  // ---- control wires
  logic           start, busy, done_set, err_set, load, drain;
  logic [1:0]     err_code;
  logic           rd_has_burst, rd_start, rd_busy, rd_done, rd_err;
  logic           wr_has_burst, wr_start, wr_busy, wr_done, wr_err;
  logic           fifo_full, fifo_empty, fifo_almost_full;

  // ---- configuration
  logic [AW-1:0]  src_base, dst_base;
  logic [LW-1:0]  len;

  // ---- datapath wires
  logic [AW-1:0]  rd_burst_addr, wr_burst_addr;
  logic [BLW-1:0] rd_burst_len, wr_burst_len;
  logic [BW-1:0]  rd_total_beats, wr_total_beats;
  logic           fifo_push, fifo_pop;
  logic [DW-1:0]  fifo_wdata, fifo_rdata;
  logic           pk_valid, pk_ready;
  logic [DW-1:0]  packed_data;
  logic [NB-1:0]  packed_strb;

  dma_csr #(.AW(AW), .LW(LW)) u_csr (
    .clk, .rst_n,
    .csr_we, .csr_addr, .csr_wdata, .csr_rdata,
    .start, .src_base, .dst_base, .len,
    .busy, .done_set, .err_set, .err_code, .irq
  );

  dma_ctrl #(.BW(BW), .BLW(BLW)) u_ctrl (
    .clk, .rst_n,
    .start, .len_zero(len == '0), .src_off(src_base[2:0]), .dst_off(dst_base[2:0]),
    .busy, .drain, .done_set, .err_set, .err_code,
    .load,
    .rd_has_burst, .rd_start, .rd_busy, .rd_done, .rd_err, .fifo_push, .fifo_almost_full,
    .wr_has_burst, .wr_burst_len, .wr_start, .wr_busy, .wr_done, .wr_err
  );

  dma_addr_gen #(.AW(AW), .LW(LW), .MAX_BURST(MAX_BURST)) u_rd_agen (
    .clk, .rst_n,
    .load, .base(src_base), .len, .burst_ack(rd_start), .has_burst(rd_has_burst),
    .burst_addr(rd_burst_addr), .burst_len(rd_burst_len), .total_beats(rd_total_beats)
  );

  dma_addr_gen #(.AW(AW), .LW(LW), .MAX_BURST(MAX_BURST)) u_wr_agen (
    .clk, .rst_n,
    .load, .base(dst_base), .len, .burst_ack(wr_start), .has_burst(wr_has_burst),
    .burst_addr(wr_burst_addr), .burst_len(wr_burst_len), .total_beats(wr_total_beats)
  );

  dma_rd_port #(.AW(AW), .DW(DW), .BLW(BLW)) u_rd_port (
    .clk, .rst_n,
    .start(rd_start), .addr(rd_burst_addr), .len(rd_burst_len),
    .busy(rd_busy), .done(rd_done), .err(rd_err),
    .rd_req_valid, .rd_req_ready, .rd_req_addr, .rd_req_len,
    .rd_rsp_valid, .rd_rsp_ready, .rd_rsp_data, .rd_rsp_err,
    .fifo_push, .fifo_wdata, .fifo_full
  );

  dma_fifo #(.DW(DW), .DEPTH(FIFO_DEPTH), .AF_LEVEL(FIFO_DEPTH - MAX_BURST)) u_fifo (
    .clk, .rst_n, .clear(load),
    .push(fifo_push), .wdata(fifo_wdata), .full(fifo_full), .almost_full(fifo_almost_full),
    .pop(fifo_pop), .rdata(fifo_rdata), .empty(fifo_empty), .level(fifo_level)
  );

  dma_packer #(.DW(DW), .BW(BW)) u_packer (
    .clk, .rst_n,
    .load, .drain, .src_off(src_base[2:0]), .dst_off(dst_base[2:0]), .len_lo(len[2:0]),
    .in_beats(rd_total_beats), .out_beats(wr_total_beats),
    .in_valid(!fifo_empty), .in_ready(fifo_pop), .in_data(fifo_rdata),
    .out_valid(pk_valid), .out_ready(pk_ready), .out_data(packed_data), .out_strb(packed_strb)
  );

  dma_wr_port #(.AW(AW), .DW(DW), .BLW(BLW)) u_wr_port (
    .clk, .rst_n,
    .start(wr_start), .addr(wr_burst_addr), .len(wr_burst_len),
    .busy(wr_busy), .done(wr_done), .err(wr_err),
    .pk_valid, .pk_ready, .pk_data(packed_data), .pk_strb(packed_strb),
    .wr_req_valid, .wr_req_ready, .wr_req_addr, .wr_req_len,
    .wr_dat_valid, .wr_dat_ready, .wr_dat_data, .wr_dat_strb, .wr_dat_last,
    .wr_rsp_valid, .wr_rsp_err
  );

endmodule
