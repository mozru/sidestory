// dma_fifo: a synchronous first-word-fall-through FIFO between the read port and the packer.
// almost_full tells dma_ctrl there's no room for another full burst, which is how backpressure
// from the write side reaches the read side.
module dma_fifo #(
  parameter int DW       = 64,
  parameter int DEPTH    = 32,
  parameter int AF_LEVEL = 16,   // almost_full once more than this many entries are held
  parameter int PW       = $clog2(DEPTH)
) (
  input  logic          clk,
  input  logic          rst_n,
  input  logic          clear,     // empty it (a new transfer starts)
  // write side
  input  logic          push,
  input  logic [DW-1:0] wdata,
  output logic          full,
  output logic          almost_full,
  // read side
  input  logic          pop,
  output logic [DW-1:0] rdata,
  output logic          empty,
  output logic [PW:0]   level
);

  // ---- datapath: storage and the two pointers
  logic [DW-1:0] mem [DEPTH];
  logic [PW-1:0] wptr_q, rptr_q;
  logic [PW:0]   count_q;
  logic          do_push, do_pop;

  assign do_push = push && !full;
  assign do_pop  = pop && !empty;

  always_ff @(posedge clk) begin
    if (do_push) mem[wptr_q] <= wdata;
  end

  assign rdata = mem[rptr_q];   // first word falls through

  // ---- control: pointers and occupancy
  always_ff @(posedge clk or negedge rst_n) begin
    if (!rst_n) begin
      wptr_q  <= '0;
      rptr_q  <= '0;
      count_q <= '0;
    end else if (clear) begin
      wptr_q  <= '0;
      rptr_q  <= '0;
      count_q <= '0;
    end else begin
      if (do_push) wptr_q <= wptr_q + 1'b1;
      if (do_pop)  rptr_q <= rptr_q + 1'b1;
      unique case ({do_push, do_pop})
        2'b10:   count_q <= count_q + 1'b1;
        2'b01:   count_q <= count_q - 1'b1;
        default: ;
      endcase
    end
  end

  assign full        = count_q == (PW+1)'(DEPTH);
  assign empty       = count_q == '0;
  assign almost_full = count_q > (PW+1)'(AF_LEVEL);
  assign level       = count_q;

endmodule
