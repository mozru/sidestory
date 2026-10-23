// dma_rd_port: issues one read burst at a time on the read request channel and pushes the
// response beats into the FIFO. It stops accepting beats while the FIFO is full.
module dma_rd_port #(
  parameter int AW  = 32,
  parameter int DW  = 64,
  parameter int BLW = 5
) (
  input  logic           clk,
  input  logic           rst_n,
  // control (dma_ctrl)
  input  logic           start,
  input  logic [AW-1:0]  addr,
  input  logic [BLW-1:0] len,
  output logic           busy,      // a burst is in flight
  output logic           done,      // pulse with the burst's last beat
  output logic           err,       // valid with done: some beat had an error
  // read request channel
  output logic           rd_req_valid,
  input  logic           rd_req_ready,
  output logic [AW-1:0]  rd_req_addr,
  output logic [BLW-1:0] rd_req_len,
  // read response channel
  input  logic           rd_rsp_valid,
  output logic           rd_rsp_ready,
  input  logic [DW-1:0]  rd_rsp_data,
  input  logic           rd_rsp_err,
  // to the FIFO
  output logic           fifo_push,
  output logic [DW-1:0]  fifo_wdata,
  input  logic           fifo_full
);

  logic           req_q;      // request waiting for rd_req_ready
  logic [AW-1:0]  addr_q;
  logic [BLW-1:0] len_q;
  logic [BLW-1:0] left_q;     // response beats still expected
  logic           err_q;
  logic           beat;

  // ---- handshakes
  assign rd_req_valid = req_q;
  assign rd_req_addr  = addr_q;
  assign rd_req_len   = len_q;
  assign rd_rsp_ready = (left_q != '0) && !fifo_full;
  assign beat         = rd_rsp_valid && rd_rsp_ready;

  // ---- datapath: response data goes straight into the FIFO
  assign fifo_push  = beat;
  assign fifo_wdata = rd_rsp_data;

  always_ff @(posedge clk or negedge rst_n) begin
    if (!rst_n) begin
      req_q  <= 1'b0;
      addr_q <= '0;
      len_q  <= '0;
      left_q <= '0;
      err_q  <= 1'b0;
    end else if (start) begin
      req_q  <= 1'b1;
      addr_q <= addr;
      len_q  <= len;
      left_q <= len;
      err_q  <= 1'b0;
    end else begin
      if (rd_req_valid && rd_req_ready) req_q <= 1'b0;
      if (beat) begin
        left_q <= left_q - 1'b1;
        err_q  <= err_q | rd_rsp_err;
      end
    end
  end

  assign busy = req_q || (left_q != '0);
  assign done = beat && (left_q == BLW'(1));
  assign err  = err_q || rd_rsp_err;

endmodule
