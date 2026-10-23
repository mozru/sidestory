// dma_wr_port: issues one write burst at a time, streams the packer's beats onto the write
// data channel (the bus may stall it with wr_dat_ready), marks the burst's last beat, and
// waits for the write response.
module dma_wr_port #(
  parameter int AW  = 32,
  parameter int DW  = 64,
  parameter int BLW = 5,
  parameter int NB  = DW / 8
) (
  input  logic           clk,
  input  logic           rst_n,
  // control (dma_ctrl)
  input  logic           start,
  input  logic [AW-1:0]  addr,
  input  logic [BLW-1:0] len,
  output logic           busy,     // a burst is in flight: don't start another
  output logic           done,     // pulse with the write response
  output logic           err,      // valid with done
  // from the packer
  input  logic           pk_valid,
  output logic           pk_ready,
  input  logic [DW-1:0]  pk_data,
  input  logic [NB-1:0]  pk_strb,
  // write request channel
  output logic           wr_req_valid,
  input  logic           wr_req_ready,
  output logic [AW-1:0]  wr_req_addr,
  output logic [BLW-1:0] wr_req_len,
  // write data channel
  output logic           wr_dat_valid,
  input  logic           wr_dat_ready,
  output logic [DW-1:0]  wr_dat_data,
  output logic [NB-1:0]  wr_dat_strb,
  output logic           wr_dat_last,
  // write response channel
  input  logic           wr_rsp_valid,
  input  logic           wr_rsp_err
);

  logic           req_q;     // request waiting for wr_req_ready
  logic           rsp_q;     // last beat sent, waiting for the response
  logic [AW-1:0]  addr_q;
  logic [BLW-1:0] len_q;
  logic [BLW-1:0] left_q;    // data beats still to send
  logic           sending;
  logic           beat;

  // ---- handshakes: the bus's wr_dat_ready is the packer's pk_ready (backpressure)
  assign sending      = left_q != '0;
  assign wr_dat_valid = pk_valid && sending;
  assign pk_ready     = wr_dat_ready && sending;
  assign beat         = wr_dat_valid && wr_dat_ready;

  // ---- datapath: beats pass straight through
  assign wr_dat_data  = pk_data;
  assign wr_dat_strb  = pk_strb;
  assign wr_dat_last  = left_q == BLW'(1);

  assign wr_req_valid = req_q;
  assign wr_req_addr  = addr_q;
  assign wr_req_len   = len_q;

  always_ff @(posedge clk or negedge rst_n) begin
    if (!rst_n) begin
      req_q  <= 1'b0;
      rsp_q  <= 1'b0;
      addr_q <= '0;
      len_q  <= '0;
      left_q <= '0;
    end else if (start) begin
      req_q  <= 1'b1;
      addr_q <= addr;
      len_q  <= len;
      left_q <= len;
    end else begin
      if (wr_req_valid && wr_req_ready) req_q <= 1'b0;
      if (beat) begin
        left_q <= left_q - 1'b1;
        if (wr_dat_last) rsp_q <= 1'b1;
      end
      if (rsp_q && wr_rsp_valid) rsp_q <= 1'b0;
    end
  end

  assign busy = req_q || sending || rsp_q;
  assign done = rsp_q && wr_rsp_valid;
  assign err  = wr_rsp_err;

endmodule
